import { memo, useEffect, useState, type ImgHTMLAttributes, type ReactNode } from "react";

import { readPrimaryBrowserAgentSidebarSessionToken } from "../environments/primary";
import { shouldFetchImageWithBearer } from "./AuthenticatedImage.logic";

interface AuthenticatedImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> {
  readonly src: string | null | undefined;
  readonly fallback?: ReactNode;
}

function shouldFetchWithSidebarToken(src: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return shouldFetchImageWithBearer({
    src,
    bearerToken: readPrimaryBrowserAgentSidebarSessionToken(),
    currentOrigin: window.location.origin,
  });
}

function initialImageSrc(src: string | null | undefined): string | null {
  if (!src) {
    return null;
  }
  return shouldFetchWithSidebarToken(src) ? null : src;
}

function useAuthenticatedImageSrc(src: string | null | undefined): string | null {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() => initialImageSrc(src));

  useEffect(() => {
    if (!src) {
      setResolvedSrc(null);
      return;
    }

    const bearerToken = readPrimaryBrowserAgentSidebarSessionToken();
    if (
      !shouldFetchImageWithBearer({
        src,
        bearerToken,
        currentOrigin: window.location.origin,
      })
    ) {
      setResolvedSrc(src);
      return;
    }

    const controller = new AbortController();
    let objectUrl: string | null = null;
    let active = true;
    setResolvedSrc(null);

    void fetch(src, {
      credentials: "include",
      headers: {
        authorization: `Bearer ${bearerToken}`,
      },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load image (${response.status}).`);
        }
        return await response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) {
          setResolvedSrc(objectUrl);
        } else {
          URL.revokeObjectURL(objectUrl);
        }
      })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) {
          return;
        }
        setResolvedSrc(null);
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [src]);

  return resolvedSrc;
}

export const AuthenticatedImage = memo(function AuthenticatedImage({
  src,
  fallback = null,
  ...props
}: AuthenticatedImageProps) {
  const resolvedSrc = useAuthenticatedImageSrc(src);
  if (!resolvedSrc) {
    return fallback;
  }

  return <img {...props} src={resolvedSrc} />;
});
