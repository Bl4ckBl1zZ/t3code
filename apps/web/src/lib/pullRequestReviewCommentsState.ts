import type { EnvironmentId, ReviewPullRequestCommentsResult } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ensureEnvironmentApi } from "../environmentApi";

interface PullRequestCommentsTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly pullRequestNumber: number | null;
}

interface PullRequestCommentsState {
  readonly data: ReviewPullRequestCommentsResult | null;
  readonly error: unknown;
  readonly isFetching: boolean;
  readonly refresh: () => void;
}

const EMPTY_PULL_REQUEST_COMMENTS_STATE = {
  data: null,
  error: null,
  isFetching: false,
} satisfies Omit<PullRequestCommentsState, "refresh">;

function targetKey(target: PullRequestCommentsTarget): string | null {
  if (!target.environmentId || !target.cwd || !target.pullRequestNumber) {
    return null;
  }
  return `${target.environmentId}:${target.cwd}:${target.pullRequestNumber}`;
}

export function usePullRequestReviewComments(
  target: PullRequestCommentsTarget,
): PullRequestCommentsState {
  const stableTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      pullRequestNumber: target.pullRequestNumber,
    }),
    [target.cwd, target.environmentId, target.pullRequestNumber],
  );
  const key = targetKey(stableTarget);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [state, setState] = useState<Omit<PullRequestCommentsState, "refresh">>(
    EMPTY_PULL_REQUEST_COMMENTS_STATE,
  );

  useEffect(() => {
    if (
      !key ||
      !stableTarget.environmentId ||
      !stableTarget.cwd ||
      !stableTarget.pullRequestNumber
    ) {
      setState(EMPTY_PULL_REQUEST_COMMENTS_STATE);
      return;
    }

    let cancelled = false;
    setState((current) => ({
      data: current.data,
      error: null,
      isFetching: true,
    }));

    ensureEnvironmentApi(stableTarget.environmentId)
      .review.listPullRequestComments({
        cwd: stableTarget.cwd,
        pullRequestNumber: stableTarget.pullRequestNumber,
      })
      .then((result) => {
        if (!cancelled) {
          setState({ data: result, error: null, isFetching: false });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState((current) => ({ data: current.data, error, isFetching: false }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [key, refreshNonce, stableTarget]);

  const refresh = useCallback(() => {
    setRefreshNonce((value) => value + 1);
  }, []);

  return { ...state, refresh };
}
