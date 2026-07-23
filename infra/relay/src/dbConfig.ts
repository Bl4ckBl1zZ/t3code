export interface RelayDatabaseConnection {
  readonly scheme: "postgres" | "postgresql";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

export type RelayHyperdriveTls =
  | {
      readonly sslmode: "require";
    }
  | {
      readonly caCertificateId: string;
      readonly sslmode: "verify-full";
    };

export class RelayDatabaseUrlError extends Error {
  override readonly name = "RelayDatabaseUrlError";
}

const decodeUrlComponent = (value: string, field: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RelayDatabaseUrlError(`DATABASE_URL has an invalid ${field}.`);
  }
};

const requireValue = (value: string, field: string): string => {
  if (value.length === 0) {
    throw new RelayDatabaseUrlError(`DATABASE_URL must include ${field}.`);
  }
  return value;
};

export function parseRelayDatabaseUrl(value: string): RelayDatabaseConnection {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayDatabaseUrlError("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new RelayDatabaseUrlError("DATABASE_URL must use postgres:// or postgresql://.");
  }

  const port = url.port.length > 0 ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RelayDatabaseUrlError("DATABASE_URL must include a valid PostgreSQL port.");
  }

  const databasePath = url.pathname.replace(/^\/+/u, "");
  if (databasePath.includes("/")) {
    throw new RelayDatabaseUrlError("DATABASE_URL must identify exactly one database.");
  }

  return {
    scheme: url.protocol === "postgres:" ? "postgres" : "postgresql",
    host: requireValue(url.hostname, "a host"),
    port,
    database: requireValue(decodeUrlComponent(databasePath, "database name"), "a database name"),
    user: requireValue(decodeUrlComponent(url.username, "username"), "a username"),
    password: requireValue(decodeUrlComponent(url.password, "password"), "a password"),
  };
}

export function resolveRelayHyperdriveTls(caCertificateId: string | undefined): RelayHyperdriveTls {
  return caCertificateId === undefined
    ? { sslmode: "require" }
    : {
        caCertificateId,
        sslmode: "verify-full",
      };
}
