export interface RelayDatabaseConnection {
  readonly scheme: "postgres" | "postgresql";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

export interface ExistingRelayHyperdriveBinding {
  readonly hyperdriveId: string;
  readonly devOrigin: {
    readonly scheme: RelayDatabaseConnection["scheme"];
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly sslmode: "require";
  };
}

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

export function existingRelayHyperdriveBinding(
  hyperdriveId: string,
  connection: RelayDatabaseConnection,
): ExistingRelayHyperdriveBinding {
  return {
    hyperdriveId,
    devOrigin: {
      scheme: connection.scheme,
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password,
      sslmode: "require",
    },
  };
}
