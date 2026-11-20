export interface DigestReactivationView {
  enabled: boolean;
  known: boolean;
  loading: boolean;
  unavailable: boolean;
  refresh: () => Promise<void>;
  save: (enabled: boolean) => Promise<void>;
}

export type UseDigestReactivation = (uid: string | null, subscribed: boolean, emailVerified: boolean) => DigestReactivationView;
