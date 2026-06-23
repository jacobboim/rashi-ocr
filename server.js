const express = require("express");
const multer = require("multer");
const tesseract = require("node-tesseract-ocr");
const Jimp = require("jimp");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const Anthropic = require("@anthropic-ai/sdk").default;

const app = express();
app.use(cors());
app.use(express.json());
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const upload = multer({ dest: os.tmpdir() });

function log(msg, extra = "") {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
  console.log(`[${ts}] ${msg}${extra ? "  " + extra : ""}`);
}

function elapsed(startMs) {
  const s = ((Date.now() - startMs) / 1000).toFixed(1);
  return `(${s}s)`;
}

async function preprocessImage(imagePath) {
  const outPath = imagePath.replace(".png", "_processed.png");
  const image = await Jimp.read(imagePath);
  image
    .greyscale()
    .normalize()
    .convolute([[0, -1, 0], [-1, 5, -1], [0, -1, 0]]);
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, (x, y, idx) => {
    const val = image.bitmap.data[idx] < 150 ? 0 : 255;
    image.bitmap.data[idx] = val;
    image.bitmap.data[idx + 1] = val;
    image.bitmap.data[idx + 2] = val;
  });
  await image.writeAsync(outPath);
  return outPath;
}

async function convertPdfToImages(pdfPath) {
  const outDir = path.join(os.tmpdir(), `rashi_${Date.now()}`);
  await fs.mkdir(outDir, { recursive: true });
  const outPrefix = path.join(outDir, "page");
  await new Promise((resolve, reject) => {
    const { execFile } = require("child_process");
    execFile("pdftoppm", ["-r", "400", "-png", pdfPath, outPrefix], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  const files = await fs.readdir(outDir);
  return files
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f) => path.join(outDir, f));
}

async function ocrImage(imagePath, lang) {
  const config = {
    lang,
    oem: 1,
    psm: 6,
  };
  return tesseract.recognize(imagePath, config);
}

async function ocrImageTwoColumn(imagePath, lang) {
  const image = await Jimp.read(imagePath);
  const { width, height } = image.bitmap;
  const halfW = Math.floor(width / 2);

  const leftPath = imagePath.replace(".png", "_left.png");
  const rightPath = imagePath.replace(".png", "_right.png");

  await image.clone().crop(0, 0, halfW, height).writeAsync(rightPath);
  await image.clone().crop(halfW, 0, width - halfW, height).writeAsync(leftPath);

  const config = { lang, oem: 1, psm: 6 };
  const [rightText, leftText] = await Promise.all([
    tesseract.recognize(rightPath, config),
    tesseract.recognize(leftPath, config),
  ]);

  return leftText.trim() + "\n\n" + rightText.trim();
}

async function ocrImageClaude(imagePath) {
  const client = new Anthropic();
  const imageData = await fs.readFile(imagePath);
  const base64 = imageData.toString("base64");

  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: base64 },
          },
          {
            type: "text",
            text: 'This image contains Hebrew text written in Rashi script (כתב רש"י), a semi-cursive Hebrew script used in traditional Jewish texts. Please transcribe ALL the Hebrew text you see in this image exactly as written, preserving line breaks. Output only the transcribed text with no commentary or explanation.',
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

// Stream OCR progress via SSE
app.post("/ocr", upload.single("pdf"), async (req, res) => {
  const lang = req.body.lang || "heb_rashi";
  const engine = req.body.engine || "tesseract";
  const columns = parseInt(req.body.columns || "1", 10);
  const preprocess = engine === "tesseract" && req.body.preprocess !== "0";
  const jobStart = Date.now();
  const fileSizeKB = req.file ? (req.file.size / 1024).toFixed(1) : "?";

  log(
    `▶ OCR job started`,
    `file="${req.file?.originalname || req.file?.filename}" size=${fileSizeKB}KB lang=${lang} engine=${engine} preprocess=${preprocess}`,
  );

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Nginx proxy buffering for SSE
  res.flushHeaders(); // send headers immediately so the stream starts

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    log(`  PDF → images: converting at 400 DPI...`);
    const convStart = Date.now();
    send({ type: "status", message: "Converting PDF to images…" });
    const images = await convertPdfToImages(req.file.path);
    log(`  PDF → images: done, ${images.length} page(s) ${elapsed(convStart)}`);
    send({ type: "total", total: images.length });

    const CONCURRENCY = 4;
    const pages = new Array(images.length);
    let completed = 0;

    async function processPage(imagePath, pageNum) {
      const pageStart = Date.now();
      let text;
      if (engine === "claude") {
        log(`  Page ${pageNum}/${images.length}: sending to Claude Vision...`);
        send({ type: "status", message: `Claude Vision on page ${pageNum}…` });
        text = await ocrImageClaude(imagePath);
      } else {
        let processed = imagePath;
        if (preprocess) {
          log(`  Page ${pageNum}/${images.length}: preprocessing...`);
          send({ type: "status", message: `Preprocessing page ${pageNum}…` });
          processed = await preprocessImage(imagePath);
        } else {
          log(`  Page ${pageNum}/${images.length}: skipping preprocessing`);
          send({ type: "status", message: `OCR on page ${pageNum}…` });
        }
        log(
          `  Page ${pageNum}/${images.length}: running OCR (lang=${lang}, columns=${columns})...`,
        );
        text = columns === 2
          ? await ocrImageTwoColumn(processed, lang)
          : await ocrImage(processed, lang);
      }
      const chars = text.trim().length;
      completed++;
      log(
        `  Page ${pageNum}/${images.length}: done — ${chars} chars ${elapsed(pageStart)}`,
      );
      pages[pageNum - 1] = { page: pageNum, text: text.trim() };
      send({
        type: "page",
        page: pageNum,
        total: images.length,
        text: text.trim(),
        elapsedMs: Date.now() - jobStart,
      });
    }

    // Run with limited concurrency
    const queue = images.map((img, i) => () => processPage(img, i + 1));
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, queue.length) },
      async (_, wi) => {
        let idx = wi;
        while (idx < queue.length) {
          await queue[idx]();
          idx += CONCURRENCY;
        }
      },
    );
    await Promise.all(workers);

    const totalChars = pages.reduce((n, p) => n + p.text.length, 0);
    log(
      `✔ OCR job complete — ${images.length} pages, ${totalChars} total chars ${elapsed(jobStart)}`,
    );
    send({ type: "done", pages });
  } catch (err) {
    log(`✖ OCR job error ${elapsed(jobStart)}: ${err.message}`);
    send({ type: "error", message: err.message });
  } finally {
    res.end();
    try {
      await fs.unlink(req.file.path);
    } catch {}
  }
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
  console.log(`Rashi OCR server running on http://localhost:${PORT}`);
});
