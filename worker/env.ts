import type { TextExtractionEnv } from './paper-text.ts';
import type { EmbeddingEnv } from './paper-store.ts';
// Bindings come from Wrangler. Configuration may be absent in local requests;
// optional secrets are provisioned separately from wrangler.toml.
export type WorkerEnv = {
  [Key in keyof Env]?: Key extends 'AI' ? TextExtractionEnv['AI'] & EmbeddingEnv['AI'] : Env[Key] extends string ? string : Env[Key];
} & Partial<Record<
  | 'AI_ANNOTATION_MODEL'
  | 'AI_UNLIMITED_EMAILS'
  | 'CORE_API_KEY'
  | 'EMAIL_DELIVERY_LEDGER_FALLBACK'
  | 'FIREBASE_SERVICE_ACCOUNT_EMAIL'
  | 'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY'
  | 'GEMINI_API_KEY'
  | 'GETFTR_API_KEY'
  | 'GETFTR_API_URL'
  | 'NAN_API_KEY'
  | 'NASA_ADS_API_TOKEN'
  | 'NCBI_API_KEY'
  | 'OPENCITATIONS_ACCESS_TOKEN'
  | 'OPENALEX_API_KEY'
  | 'PDF_GLOBAL_MINUTE_LIMIT'
  | 'POSTHOG_PROJECT_TOKEN'
  | 'RESEND_API_KEY'
  | 'SCOPUS_PROXY_URL'
  | 'SCOPUS_PROXY_SECRET'
  | 'SCOPUS_VIEW'
  | 'SEMANTIC_SCHOLAR_API_KEY'
  | 'UNPAYWALL_EMAIL',
  string
>> & { AI_REWRITE_STORE?: Env['NOTIFICATION_STORE'] };

export type WorkerGlobals = typeof globalThis & { caches?: CacheStorage };
