import { config } from '../config.js';
import { MetaInstagramProvider } from './meta-instagram.js';
import { MockInstagramProvider } from './mock-instagram.js';
import { MockTelegramProvider } from './mock-telegram.js';
import { TelegramBotProvider } from './telegram-bot.js';
import type { InstagramProvider, TelegramProvider } from './types.js';

export * from './readiness.js';
export * from './types.js';

/**
 * Provider selection (the project's "service" seam). INTEGRATION_MODE picks mock or real implementations once;
 * `useProviders` swaps them (tests inject recording fakes, the dashboard never needs to).
 */
let override: { instagram?: InstagramProvider; telegram?: TelegramProvider } = {};
let instagram: InstagramProvider | undefined;
let telegram: TelegramProvider | undefined;

export function instagramProvider(): InstagramProvider {
  if (override.instagram) return override.instagram;
  instagram ??= config.mockMode ? new MockInstagramProvider() : new MetaInstagramProvider();
  return instagram;
}

export function telegramProvider(): TelegramProvider {
  if (override.telegram) return override.telegram;
  telegram ??= config.mockMode ? new MockTelegramProvider() : new TelegramBotProvider();
  return telegram;
}

/** Injects providers (pass `{}` to go back to the configured ones). */
export const useProviders = (p: { instagram?: InstagramProvider; telegram?: TelegramProvider } = {}) => {
  override = p;
};
