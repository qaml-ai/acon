import type { DesktopProvider } from "../../desktop/shared/protocol";
import type { DesktopProviderDefinition } from "./provider-types";
import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { opencodeProvider } from "./opencode";
import { piProvider } from "./pi";

const PROVIDERS: Record<string, DesktopProviderDefinition> = {
  [claudeProvider.id]: claudeProvider,
  [codexProvider.id]: codexProvider,
  [piProvider.id]: piProvider,
  [opencodeProvider.id]: opencodeProvider,
};

export function getSupportedDesktopProviders(): DesktopProviderDefinition[] {
  return Object.values(PROVIDERS);
}

export function getDefaultDesktopProvider(): DesktopProviderDefinition {
  if (codexProvider.getAuthState().available && !claudeProvider.getAuthState().available) {
    return codexProvider;
  }
  if (claudeProvider.getAuthState().available) {
    return claudeProvider;
  }
  if (codexProvider.getAuthState().available) {
    return codexProvider;
  }
  if (piProvider.getAuthState().available) {
    return piProvider;
  }
  if (opencodeProvider.getAuthState().available) {
    return opencodeProvider;
  }
  return claudeProvider;
}

export function getDefaultProvider(): DesktopProvider {
  return getDefaultDesktopProvider().id;
}

export function getDesktopProvider(
  providerId: string | null | undefined,
): DesktopProviderDefinition | null {
  if (!providerId) {
    return null;
  }
  return PROVIDERS[providerId] ?? null;
}

export function requireDesktopProvider(
  providerId: string | null | undefined,
): DesktopProviderDefinition {
  return getDesktopProvider(providerId) ?? getDefaultDesktopProvider();
}

export function getProviderOptions() {
  return getSupportedDesktopProviders().map((provider) => provider.option);
}
