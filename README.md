# Rashi OCR

Drag-and-drop PDF → Hebrew Rashi script text extractor.

## Setup

### 1. Install system dependencies

```bash
# macOS
brew install tesseract poppler

# Download the Rashi trained model
TESSDATA=$(tesseract --list-langs 2>&1 | head -1 | sed 's/List of available tessdata files in //')
curl -L https://gitlab.com/pninim.org/tessdata_heb_rashi/-/raw/main/heb_rashi.traineddata \
  -o "$TESSDATA/heb_rashi.traineddata"
```

### 2. Install Node dependencies

```bash
npm install
```

### 3. Start the server

```bash
npm start
```

### 4. Open the UI

Open `index.html` in your browser (or serve it with any static server).

## Usage

1. Drop a scanned PDF onto the drop zone
2. Select the script model (Rashi, Square Hebrew, or Mixed)
3. Watch pages process in real time — extracted Hebrew text appears on the right
4. Copy to clipboard or download as `.txt`

## Script Models

| Model | Use for |
|-------|---------|
| `heb_rashi` | Rashi commentary, Tosafot, responsa in Rashi script |
| `heb` | Standard square Hebrew print |
| `heb+heb_rashi` | Pages mixing both scripts (e.g. Gemara page with Rashi) |
# rashi-ocr
