/**
 * Vision Delegate Extension for Pi
 *
 * Allows a text-only model (e.g. xiaomi/mimo-v2.5-pro) to delegate vision
 * tasks to a multimodal model (e.g. xiaomi/mimo-v2.5) via OpenRouter.
 *
 * Auto-detects API key from Pi's auth.json — no manual env vars needed.
 * Override with env vars: VISION_API_BASE_URL, VISION_API_KEY, VISION_MODEL
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { homedir } from "node:os";

// ── Config ──────────────────────────────────────────────────────────────────

interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

async function getConfig(): Promise<VisionConfig> {
  // 1. Try env vars first
  if (process.env.VISION_API_BASE_URL && process.env.VISION_MODEL) {
    return {
      baseUrl: process.env.VISION_API_BASE_URL,
      apiKey: process.env.VISION_API_KEY || "none",
      model: process.env.VISION_MODEL,
      maxTokens: parseInt(process.env.VISION_MAX_TOKENS || "1024", 10),
    };
  }

  // 2. Auto-detect from Pi's auth.json
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  try {
    const authRaw = await readFile(authPath, "utf-8");
    const auth = JSON.parse(authRaw);

    // Prefer openrouter key (same provider as main model)
    if (auth.openrouter?.key) {
      return {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: auth.openrouter.key,
        model: "xiaomi/mimo-v2.5",
        maxTokens: 1024,
      };
    }

    // Fallback: xiaomi direct token
    if (auth["xiaomi-token-plan-sgp"]?.key) {
      return {
        baseUrl: "https://api.xiaomi.com/v1", // adjust if needed
        apiKey: auth["xiaomi-token-plan-sgp"].key,
        model: "xiaomi/mimo-v2.5",
        maxTokens: 1024,
      };
    }
  } catch {
    // auth.json not found or unreadable
  }

  // 3. Final fallback
  return {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
    model: "xiaomi/mimo-v2.5",
    maxTokens: 1024,
  };
}

// ── MIME detection ──────────────────────────────────────────────────────────

function guessMime(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".svg": "image/svg+xml",
  };
  return map[ext] || "image/png";
}

// ── Vision API call ─────────────────────────────────────────────────────────

interface VisionResult {
  description: string;
  model: string;
  tokensUsed?: number;
}

async function callVisionModel(
  imageBase64: string,
  mimeType: string,
  prompt: string,
  config: VisionConfig,
  signal?: AbortSignal,
): Promise<VisionResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`,
            },
          },
        ],
      },
    ],
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.apiKey && config.apiKey !== "none") {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(
      `Vision API error ${response.status}: ${errorText}\n` +
        `URL: ${url}\nModel: ${config.model}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { total_tokens?: number };
  };

  const description = data.choices?.[0]?.message?.content;
  if (!description) {
    throw new Error("Vision model returned empty response");
  }

  return {
    description,
    model: config.model,
    tokensUsed: data.usage?.total_tokens,
  };
}

// ── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Cache config on session start
  let cachedConfig: VisionConfig | null = null;

  pi.on("session_start", async (_event, ctx) => {
    cachedConfig = await getConfig();

    if (!cachedConfig.apiKey) {
      ctx.ui.setStatus(
        "vision",
        "vision: ⚠ no API key",
      );
      ctx.ui.notify(
        "Vision delegate: No API key found. Set VISION_API_KEY or configure OpenRouter in /login",
        "warning",
      );
    } else {
      ctx.ui.setStatus("vision", `vision: ${cachedConfig.model}`);
    }
  });

  // ── Register the vision_describe tool ─────────────────────────────────────

  pi.registerTool({
    name: "vision_describe",
    label: "Vision Describe",
    description:
      "Delegate image analysis to a multimodal vision model. " +
      "Use this tool when you need to understand, describe, or analyze " +
      "the contents of an image but you yourself cannot see images. " +
      "Accepts a file path (relative to cwd or absolute) or a base64 string.",
    promptSnippet:
      "Delegate image understanding to a multimodal vision model",
    promptGuidelines: [
      "Use vision_describe when you need to see or analyze an image file " +
        "but cannot view images directly. Provide the file path and a clear " +
        "question about what to describe or analyze in the image.",
      "Use vision_describe for screenshots, diagrams, photos, UI mockups, " +
        "error screenshots, or any visual content the user references.",
    ],
    parameters: Type.Object({
      image: Type.String({
        description:
          "Path to the image file (absolute or relative to cwd), " +
          "or a base64-encoded image string",
      }),
      prompt: Type.String({
        description:
          "Specific question or instruction about the image. " +
          "Examples: 'Describe all UI elements visible', " +
          "'What text is shown in this screenshot?', " +
          "'Explain this diagram in detail'",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Ensure config is loaded
      if (!cachedConfig) {
        cachedConfig = await getConfig();
      }

      const config = cachedConfig;

      if (!config.apiKey) {
        throw new Error(
          "No API key configured for vision model. " +
            "Set VISION_API_KEY env var or log in to OpenRouter via /login",
        );
      }

      // Notify progress
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Sending to vision model (${config.model})...`,
          },
        ],
      });

      let imageBase64: string;
      let mimeType: string;
      const imageInput = params.image.trim();

      // ── Parse image input ───────────────────────────────────────────────

      if (imageInput.startsWith("data:")) {
        // Inline data URI: data:image/png;base64,AAAA...
        const match = imageInput.match(
          /^data:([a-z]+\/[a-z+\-.]+);base64,(.+)$/s,
        );
        if (!match) {
          throw new Error(
            "Invalid data URI format. Expected: data:<mime>;base64,<data>",
          );
        }
        mimeType = match[1];
        imageBase64 = match[2];
      } else if (
        imageInput.length > 256 &&
        !imageInput.includes("\n") &&
        /^[A-Za-z0-9+/=\s]+$/.test(imageInput)
      ) {
        // Looks like raw base64
        mimeType = "image/png";
        imageBase64 = imageInput;
      } else {
        // Treat as file path
        const absPath = resolve(ctx.cwd, imageInput);
        try {
          const buffer = await readFile(absPath);
          imageBase64 = buffer.toString("base64");
          mimeType = guessMime(absPath);
        } catch (err: any) {
          throw new Error(
            `Cannot read image file: ${absPath}\n` +
              `Error: ${err.message}\n` +
              `Make sure the file exists and is readable.`,
          );
        }
      }

      // ── Update progress ─────────────────────────────────────────────────

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Analyzing with ${config.model}...`,
          },
        ],
      });

      // ── Call vision model ───────────────────────────────────────────────

      const result = await callVisionModel(
        imageBase64,
        mimeType,
        params.prompt,
        config,
        signal,
      );

      // ── Format response for text-only agent ────────────────────────────

      const responseText = [
        `## Vision Analysis (via ${result.model})`,
        "",
        `**Question:** ${params.prompt}`,
        "",
        `**Description:**`,
        result.description,
        "",
        result.tokensUsed ? `*Tokens used: ${result.tokensUsed}*` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [{ type: "text", text: responseText }],
        details: {
          visionModel: result.model,
          tokensUsed: result.tokensUsed,
          mimeType,
          question: params.prompt,
        },
      };
    },

    // ── Custom TUI rendering ──────────────────────────────────────────────

    renderCall(args, theme) {
      const { Text } = require("@earendil-works/pi-tui");
      const path =
        args.image?.length > 60
          ? "..." + args.image.slice(-57)
          : args.image ?? "image";
      return new Text(
        theme.fg("toolTitle", "vision_describe ") +
          theme.fg("muted", path),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const { Text } = require("@earendil-works/pi-tui");

      if (result.details?.error) {
        return new Text(
          theme.fg("error", `Error: ${result.details.error}`),
          0,
          0,
        );
      }

      const model = result.details?.visionModel ?? "unknown";
      const tokens = result.details?.tokensUsed;

      let text =
        theme.fg("success", "✓ ") +
        theme.fg("accent", model) +
        (tokens ? theme.fg("dim", ` (${tokens} tokens)`) : "");

      if (expanded) {
        text += "\n" + theme.fg("muted", result.content?.[0]?.text ?? "");
      }

      return new Text(text, 0, 0);
    },
  });

  // ── Test command ──────────────────────────────────────────────────────────

  pi.registerCommand("vision-test", {
    description: "Test vision model connection and config",
    handler: async (_args, ctx) => {
      const config = cachedConfig ?? (await getConfig());

      const lines = [
        `Model:      ${config.model}`,
        `API:        ${config.baseUrl}`,
        `API Key:    ${config.apiKey ? "✓ configured" : "✗ not set"}`,
        `Max Tokens: ${config.maxTokens}`,
      ];

      // Quick connectivity test
      if (config.apiKey) {
        try {
          const testUrl = `${config.baseUrl.replace(/\/+$/, "")}/models`;
          const resp = await fetch(testUrl, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
          });
          lines.push(`Status:     ${resp.ok ? "✓ connected" : "✗ error " + resp.status}`);
        } catch (err: any) {
          lines.push(`Status:     ✗ ${err.message}`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
