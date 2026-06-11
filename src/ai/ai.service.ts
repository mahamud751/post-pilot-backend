import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class AiService {
  constructor(private readonly configService: ConfigService) {}

  async captionSuggestions(topic = "your post", tone = "friendly") {
    const geminiKey = this.configService.get<string>("GEMINI_API_KEY");
    if (geminiKey) {
      return this.geminiSuggestions(geminiKey, topic, tone);
    }

    const openAiKey = this.configService.get<string>("OPENAI_API_KEY");
    if (openAiKey) {
      return this.openAiSuggestions(openAiKey, topic, tone);
    }

    throw new ServiceUnavailableException(
      "GEMINI_API_KEY or OPENAI_API_KEY must be configured on the server",
    );
  }

  private async geminiSuggestions(apiKey: string, topic: string, tone: string) {
    const model = this.configService.get<string>(
      "GEMINI_MODEL",
      "gemini-2.0-flash",
    );
    const prompt = [
      "You are a social media copywriter for Instagram, Facebook, and YouTube.",
      `Topic: ${topic}`,
      `Tone: ${tone}`,
      "Return exactly 3 concise, engaging caption suggestions.",
      "Each suggestion on its own line. No numbering or bullets.",
    ].join("\n");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 512 },
        }),
      },
    );

    const payload = await response.json();
    if (!response.ok) {
      throw new ServiceUnavailableException(
        payload?.error?.message || "Gemini request failed",
      );
    }

    const raw = String(
      payload?.candidates?.[0]?.content?.parts?.[0]?.text || "",
    );
    return { suggestions: this.parseSuggestions(raw) };
  }

  private async openAiSuggestions(apiKey: string, topic: string, tone: string) {
    const model = this.configService.get<string>("OPENAI_MODEL", "gpt-4o-mini");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.8,
        messages: [
          {
            role: "system",
            content:
              "You are a social media copywriter. Return exactly 3 concise caption suggestions.",
          },
          {
            role: "user",
            content: `Topic: ${topic}\nTone: ${tone}\nReturn each suggestion on a new line.`,
          },
        ],
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new ServiceUnavailableException(
        payload?.error?.message || "OpenAI request failed",
      );
    }

    const raw = String(payload?.choices?.[0]?.message?.content || "");
    return { suggestions: this.parseSuggestions(raw) };
  }

  private parseSuggestions(raw: string) {
    const suggestions = raw
      .split("\n")
      .map((line) =>
        line
          .replace(/^\d+[\).\-\s]*/, "")
          .replace(/^[-*]\s*/, "")
          .trim(),
      )
      .filter(Boolean)
      .slice(0, 3);

    if (suggestions.length === 0) {
      throw new ServiceUnavailableException(
        "AI provider returned empty response",
      );
    }

    return suggestions;
  }
}
