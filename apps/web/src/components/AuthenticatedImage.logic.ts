const INLINE_IMAGE_URL_SCHEMES = new Set(["blob:", "data:"]);

export function shouldFetchImageWithBearer(input: {
  readonly src: string;
  readonly bearerToken: string | null;
  readonly currentOrigin: string;
}): boolean {
  if (!input.bearerToken) {
    return false;
  }

  try {
    const url = new URL(input.src, input.currentOrigin);
    if (INLINE_IMAGE_URL_SCHEMES.has(url.protocol)) {
      return false;
    }
    return url.origin === input.currentOrigin;
  } catch {
    return false;
  }
}
