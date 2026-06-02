import type { OrganizationPanelSnapshot } from "@t3tools/contracts";
import { Component, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import type { OrganizationPanelProps } from "../organization-panels/_shared/types";

type PanelModule = {
  readonly default: ComponentType<OrganizationPanelProps>;
};

const panelModules = import.meta.glob("../organization-panels/*/Panel.tsx") as Record<
  string,
  () => Promise<PanelModule>
>;

interface OrganizationPanelHostProps {
  readonly snapshot: OrganizationPanelSnapshot;
}

interface OrganizationPanelErrorBoundaryProps {
  readonly resetKey: string;
  readonly children: ReactNode;
}

interface OrganizationPanelErrorBoundaryState {
  readonly error: Error | null;
  readonly resetKey: string;
}

class OrganizationPanelErrorBoundary extends Component<
  OrganizationPanelErrorBoundaryProps,
  OrganizationPanelErrorBoundaryState
> {
  override state: OrganizationPanelErrorBoundaryState = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: Error): Partial<OrganizationPanelErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: OrganizationPanelErrorBoundaryProps,
    state: OrganizationPanelErrorBoundaryState,
  ): Partial<OrganizationPanelErrorBoundaryState> | null {
    if (props.resetKey === state.resetKey) {
      return null;
    }
    return { error: null, resetKey: props.resetKey };
  }

  override render() {
    if (this.state.error) {
      return (
        <Alert variant="error" className="m-6 rounded-lg">
          <AlertTitle>Panel render failed</AlertTitle>
          <AlertDescription>{this.state.error.message}</AlertDescription>
          <div className="mt-3">
            <Button size="xs" variant="outline" onClick={() => this.setState({ error: null })}>
              Retry render
            </Button>
          </div>
        </Alert>
      );
    }

    return this.props.children;
  }
}

export function OrganizationPanelHost({ snapshot }: OrganizationPanelHostProps) {
  const [panel, setPanel] = useState<ComponentType<OrganizationPanelProps> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const panelImportPath = snapshot.panel.panelImportPath;
  const versionId = snapshot.panel.versionId;
  const panelProps = useMemo<OrganizationPanelProps>(
    () => ({
      organization: {
        id: snapshot.organization.id,
        slug: snapshot.organization.slug,
        name: snapshot.organization.name,
      },
      viewer: snapshot.viewer,
      runtime: {
        now: new Date(snapshot.runtime.now),
        environment: snapshot.runtime.environment,
      },
    }),
    [snapshot],
  );

  useEffect(() => {
    let cancelled = false;
    const loader = panelModules[panelImportPath];
    setPanel(null);
    setLoadError(null);

    if (!loader) {
      setLoadError(`Panel module ${panelImportPath} is not registered by Vite.`);
      return;
    }

    void loader().then(
      (module) => {
        if (!cancelled) {
          setPanel(() => module.default);
        }
      },
      (error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Panel module failed to load.");
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [panelImportPath, versionId]);

  if (loadError) {
    return (
      <Alert variant="error" className="m-6 rounded-lg">
        <AlertTitle>Panel module unavailable</AlertTitle>
        <AlertDescription>{loadError}</AlertDescription>
      </Alert>
    );
  }

  if (!panel) {
    return <div className="p-6 text-sm text-muted-foreground">Loading panel...</div>;
  }

  const Panel = panel;
  return (
    <OrganizationPanelErrorBoundary resetKey={`${panelImportPath}:${versionId}`}>
      <Panel {...panelProps} />
    </OrganizationPanelErrorBoundary>
  );
}
