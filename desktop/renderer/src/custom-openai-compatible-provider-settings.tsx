import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import type {
  DesktopCustomOpenAiCompatibleMaxTokensField,
  DesktopCustomOpenAiCompatibleProviderConfig,
  DesktopSaveCustomOpenAiCompatibleProviderConfigInput,
} from "../../shared/protocol";

const desktopShell = window.desktopShell;

type TriState = "auto" | "enabled" | "disabled";
type MaxTokensFieldValue =
  | "auto"
  | DesktopCustomOpenAiCompatibleMaxTokensField;

type FormState = {
  label: string;
  baseUrl: string;
  modelId: string;
  modelName: string;
  apiKey: string;
  headers: string;
  reasoning: boolean;
  imageInput: boolean;
  contextWindow: string;
  maxTokens: string;
  supportsDeveloperRole: TriState;
  supportsReasoningEffort: TriState;
  maxTokensField: MaxTokensFieldValue;
};

const DEFAULT_FORM_STATE: FormState = {
  label: "Custom OpenAI-Compatible",
  baseUrl: "",
  modelId: "",
  modelName: "",
  apiKey: "",
  headers: "",
  reasoning: false,
  imageInput: false,
  contextWindow: "",
  maxTokens: "",
  supportsDeveloperRole: "auto",
  supportsReasoningEffort: "auto",
  maxTokensField: "auto",
};

function triStateFromBoolean(value: boolean | null): TriState {
  if (value === true) {
    return "enabled";
  }
  if (value === false) {
    return "disabled";
  }
  return "auto";
}

function booleanFromTriState(value: TriState): boolean | null {
  if (value === "enabled") {
    return true;
  }
  if (value === "disabled") {
    return false;
  }
  return null;
}

function formStateFromConfig(
  config: DesktopCustomOpenAiCompatibleProviderConfig | null,
): FormState {
  if (!config) {
    return DEFAULT_FORM_STATE;
  }

  return {
    label: config.label ?? DEFAULT_FORM_STATE.label,
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    modelName: config.modelName ?? "",
    apiKey: "",
    headers:
      Object.keys(config.headers).length > 0
        ? JSON.stringify(config.headers, null, 2)
        : "",
    reasoning: config.reasoning,
    imageInput: config.imageInput,
    contextWindow: config.contextWindow ? String(config.contextWindow) : "",
    maxTokens: config.maxTokens ? String(config.maxTokens) : "",
    supportsDeveloperRole: triStateFromBoolean(config.supportsDeveloperRole),
    supportsReasoningEffort: triStateFromBoolean(config.supportsReasoningEffort),
    maxTokensField: config.maxTokensField ?? "auto",
  };
}

function parseHeaders(value: string): Record<string, string> {
  if (!value.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Headers must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }

  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rawValue !== "string") {
      throw new Error("Header values must be strings.");
    }
    const normalizedKey = key.trim();
    const normalizedValue = rawValue.trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    headers[normalizedKey] = normalizedValue;
  }

  return headers;
}

function buildSaveInput(form: FormState): DesktopSaveCustomOpenAiCompatibleProviderConfigInput {
  return {
    label: form.label.trim() || null,
    baseUrl: form.baseUrl.trim(),
    modelId: form.modelId.trim(),
    modelName: form.modelName.trim() || null,
    apiKey: form.apiKey.trim() || null,
    headers: parseHeaders(form.headers),
    reasoning: form.reasoning,
    imageInput: form.imageInput,
    contextWindow: form.contextWindow.trim() ? Number.parseInt(form.contextWindow, 10) : null,
    maxTokens: form.maxTokens.trim() ? Number.parseInt(form.maxTokens, 10) : null,
    supportsDeveloperRole: booleanFromTriState(form.supportsDeveloperRole),
    supportsReasoningEffort: booleanFromTriState(form.supportsReasoningEffort),
    maxTokensField: form.maxTokensField === "auto" ? null : form.maxTokensField,
  };
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

export function CustomOpenAiCompatibleProviderSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM_STATE);
  const [savedConfig, setSavedConfig] =
    useState<DesktopCustomOpenAiCompatibleProviderConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!desktopShell?.getCustomOpenAiCompatibleProviderConfig) {
        if (!cancelled) {
          setError("Provider settings are not available in this build.");
          setLoading(false);
        }
        return;
      }

      try {
        const config = await desktopShell.getCustomOpenAiCompatibleProviderConfig();
        if (cancelled) {
          return;
        }
        setSavedConfig(config);
        setForm(formStateFromConfig(config));
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasStoredApiKey = savedConfig?.hasApiKey === true;
  const saveDisabled = useMemo(
    () => saving || loading || !form.baseUrl.trim() || !form.modelId.trim(),
    [form.baseUrl, form.modelId, loading, saving],
  );

  async function handleSave() {
    if (!desktopShell?.saveCustomOpenAiCompatibleProviderConfig) {
      setError("Provider settings are not available in this build.");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const nextConfig = await desktopShell.saveCustomOpenAiCompatibleProviderConfig(
        buildSaveInput(form),
      );
      setSavedConfig(nextConfig);
      setForm(formStateFromConfig(nextConfig));
      setSuccess("Saved for both PI and OpenCode.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!desktopShell?.clearCustomOpenAiCompatibleProviderConfig) {
      setError("Provider settings are not available in this build.");
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await desktopShell.clearCustomOpenAiCompatibleProviderConfig();
      setSavedConfig(null);
      setForm(DEFAULT_FORM_STATE);
      setSuccess("Removed the custom provider from PI and OpenCode.");
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-full animate-pulse rounded-md bg-muted" />
        <div className="h-24 w-full animate-pulse rounded-md bg-muted" />
        <div className="h-24 w-full animate-pulse rounded-md bg-muted" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-medium">OpenAI-Compatible Endpoint</h2>
        <p className="text-sm text-muted-foreground">
          Save one shared custom deployment for the `Custom OpenAI-Compatible`
          model family in PI and OpenCode.
        </p>
      </div>

      {savedConfig ? (
        <Alert>
          <AlertTitle>{savedConfig.label || "Custom OpenAI-Compatible"}</AlertTitle>
          <AlertDescription>
            {savedConfig.hasApiKey
              ? "API key stored. Select the custom family from the model picker when you want to use this endpoint."
              : "No API key is stored. Select the custom family from the model picker when the endpoint does not require auth."}
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Save failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {success ? (
        <Alert>
          <AlertTitle>Updated</AlertTitle>
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      ) : null}

      <Field
        label="Label"
        description="Shown in provider status text and used as the OpenCode provider name."
      >
        <Input
          value={form.label}
          onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
          placeholder="Custom OpenAI-Compatible"
        />
      </Field>

      <Field
        label="Base URL"
        description="The OpenAI-compatible API root, usually ending in `/v1`."
      >
        <Input
          value={form.baseUrl}
          onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
          placeholder="https://api.example.com/v1"
        />
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Model ID"
          description="Sent to the deployment as the model name."
        >
          <Input
            value={form.modelId}
            onChange={(event) => setForm((current) => ({ ...current, modelId: event.target.value }))}
            placeholder="gpt-4.1"
          />
        </Field>

        <Field
          label="Display Name"
          description="Optional label for the model list when the harness exposes it."
        >
          <Input
            value={form.modelName}
            onChange={(event) => setForm((current) => ({ ...current, modelName: event.target.value }))}
            placeholder="My deployment"
          />
        </Field>
      </div>

      <Field
        label="API Key"
        description={
          hasStoredApiKey
            ? "Stored in the host secret store. Enter a new value to replace it or leave blank to keep the current one."
            : "Optional. Stored in the host secret store and injected into PI and OpenCode."
        }
      >
        <Input
          type="password"
          value={form.apiKey}
          onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
          placeholder={hasStoredApiKey ? "Stored" : "sk-..."}
        />
      </Field>

      <Field
        label="Headers"
        description="Optional JSON object for static request headers such as API versions."
      >
        <Textarea
          value={form.headers}
          onChange={(event) => setForm((current) => ({ ...current, headers: event.target.value }))}
          rows={5}
          placeholder={`{\n  "api-version": "2025-01-01"\n}`}
        />
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Context Window"
          description="Optional token limit override for PI and OpenCode metadata."
        >
          <Input
            value={form.contextWindow}
            onChange={(event) => setForm((current) => ({ ...current, contextWindow: event.target.value }))}
            inputMode="numeric"
            placeholder="128000"
          />
        </Field>

        <Field
          label="Max Output Tokens"
          description="Optional output token cap for the custom model entry."
        >
          <Input
            value={form.maxTokens}
            onChange={(event) => setForm((current) => ({ ...current, maxTokens: event.target.value }))}
            inputMode="numeric"
            placeholder="16384"
          />
        </Field>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Reasoning"
          description="Mark the model as reasoning-capable for harness model metadata."
        >
          <Toggle
            pressed={form.reasoning}
            onPressedChange={(pressed) => setForm((current) => ({ ...current, reasoning: pressed }))}
            variant="outline"
          >
            {form.reasoning ? "Enabled" : "Disabled"}
          </Toggle>
        </Field>

        <Field
          label="Image Input"
          description="Expose the model as text+image capable."
        >
          <Toggle
            pressed={form.imageInput}
            onPressedChange={(pressed) => setForm((current) => ({ ...current, imageInput: pressed }))}
            variant="outline"
          >
            {form.imageInput ? "Enabled" : "Disabled"}
          </Toggle>
        </Field>
      </div>

      <Separator />

      <div className="space-y-1">
        <h3 className="text-sm font-medium">Compatibility</h3>
        <p className="text-xs text-muted-foreground">
          Use these when the deployment is OpenAI-like but does not fully match
          the upstream API.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Field
          label="Developer Role"
          description="Set to disabled when the server only accepts `system`."
        >
          <Select
            value={form.supportsDeveloperRole}
            onValueChange={(value: TriState) =>
              setForm((current) => ({ ...current, supportsDeveloperRole: value }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="enabled">Enabled</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Reasoning Effort"
          description="Disable when the server rejects `reasoning_effort`."
        >
          <Select
            value={form.supportsReasoningEffort}
            onValueChange={(value: TriState) =>
              setForm((current) => ({ ...current, supportsReasoningEffort: value }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="enabled">Enabled</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Max Tokens Field"
          description="Override when the server expects `max_tokens`."
        >
          <Select
            value={form.maxTokensField}
            onValueChange={(value: MaxTokensFieldValue) =>
              setForm((current) => ({ ...current, maxTokensField: value }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="max_completion_tokens">
                max_completion_tokens
              </SelectItem>
              <SelectItem value="max_tokens">max_tokens</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button onClick={() => void handleSave()} disabled={saveDisabled}>
          {saving ? "Saving..." : "Save Provider"}
        </Button>
        <Button
          variant="outline"
          onClick={() => void handleClear()}
          disabled={saving || !savedConfig}
        >
          Remove Provider
        </Button>
      </div>
    </div>
  );
}
