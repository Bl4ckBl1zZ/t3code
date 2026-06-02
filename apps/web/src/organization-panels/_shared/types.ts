export type OrganizationPanelProps = Readonly<{
  organization: Readonly<{
    id: string;
    slug: string;
    name: string;
  }>;
  viewer: Readonly<{
    id: string;
    displayName: string | null;
    role: "owner" | "admin" | "member";
  }>;
  runtime: Readonly<{
    now: Date;
    environment: "local" | "staging" | "production";
  }>;
}>;
