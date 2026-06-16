# Vision Delegate Extension

Extension ini memungkinkan **text-only model** (`xiaomi/mimo-v2.5-pro`) 
untuk mendelegasikan tugas analisis gambar ke **multimodal model** 
(`xiaomi/mimo-v2.5`) via OpenRouter.

## Status: ✅ Configured & Tested

| Component | Value |
|-----------|-------|
| Provider | OpenRouter |
| Text Model (main) | `xiaomi/mimo-v2.5-pro` (text→text) |
| Vision Model (delegate) | `xiaomi/mimo-v2.5` (text+image+audio+video→text) |
| API Key | Auto-detected from `~/.pi/agent/auth.json` |
| Max Tokens | 1024 |

## Cara Kerja

```
User: "Jelaskan screenshot ini" + lampiran gambar
        │
        ▼
┌──────────────────────────────────────────────────┐
│  Agent: xiaomi/mimo-v2.5-pro (text-only)        │
│  "Saya tidak bisa lihat gambar, tapi saya punya  │
│   tool vision_describe"                          │
│                                                  │
│  → Memanggil vision_describe({                   │
│      image: "./screenshot.png",                  │
│      prompt: "Describe all UI elements"          │
│    })                                            │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│  Vision: xiaomi/mimo-v2.5 (multimodal)          │
│  Menerima gambar → mengembalikan deskripsi       │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│  Agent: xiaomi/mimo-v2.5-pro                    │
│  Menyusun respons lengkap berdasarkan deskripsi  │
│  → Mengembalikan jawaban ke user                 │
└──────────────────────────────────────────────────┘
```

## Setup

**Tidak perlu setup manual!** Extension otomatis mendeteksi API key dari 
`~/.pi/agent/auth.json` (konfigurasi OpenRouter yang sudah ada).

### Optional: Override via Environment Variables

```bash
# Pakai provider lain (misal Ollama lokal)
VISION_API_BASE_URL=http://localhost:11434/v1
VISION_API_KEY=ollama
VISION_MODEL=llava

# Pakai OpenAI langsung
VISION_API_BASE_URL=https://api.openai.com/v1
VISION_API_KEY=sk-your-key
VISION_MODEL=gpt-4o
```

## Penggunaan

### 1. Otomatis dari User

Cukup lampirkan gambar dan minta agent menganalisis:
```
Tolong jelaskan apa yang ada di screenshot ini
[lampirkan gambar]
```

Agent text-only akan otomatis memanggil `vision_describe`.

### 2. Manual dari Agent

Agent bisa memanggil tool kapan saja:
```json
{
  "tool": "vision_describe",
  "arguments": {
    "image": "/path/to/image.png",
    "prompt": "What text is visible in this image?"
  }
}
```

### 3. Test Koneksi

```
/vision-test
```

## Tool Parameters

| Parameter | Type   | Description |
|-----------|--------|-------------|
| `image`   | string | Path ke file gambar (relative/absolute) ATAU base64 string |
| `prompt`  | string | Pertanyaan spesifik tentang gambar |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No API key" | auth.json tidak punya openrouter key | Login via `/login` |
| "Vision API error 401" | Key expired/invalid | Re-login via `/login` |
| "Vision API error 404" | Model tidak tersedia | Cek model name di OpenRouter |
| "Cannot read image file" | Path salah atau permission | Pastikan file exists & readable |

## File Location

```
.pi/extensions/
├── vision-delegate.ts     ← Extension
└── VISION-DELEGATE.md     ← Dokumentasi ini
```
