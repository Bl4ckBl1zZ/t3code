import type { OrganizationPanelMetricTone, OrganizationPanelSnapshot } from "@t3tools/contracts";

import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

interface OrganizationPanelHostProps {
  readonly snapshot: OrganizationPanelSnapshot;
}

const toneLabel: Record<OrganizationPanelMetricTone, string> = {
  success: "On track",
  info: "Monitor",
  warning: "Review",
};

export function OrganizationPanelHost({ snapshot }: OrganizationPanelHostProps) {
  const document = snapshot.panel.document;
  const asOf = new Date(snapshot.runtime.now).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <section className="flex min-w-0 flex-col gap-5 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase text-muted-foreground">
            {snapshot.organization.name}
          </p>
          <h1 className="truncate text-2xl font-semibold">{document.title}</h1>
          {document.description ? (
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{document.description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{snapshot.viewer.role}</Badge>
          <span>{asOf}</span>
        </div>
      </header>

      {document.metrics.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-3">
          {document.metrics.map((metric) => (
            <Card key={metric.label} className="rounded-lg">
              <CardHeader className="p-4 pb-2">
                <CardTitle className="truncate text-sm text-muted-foreground">
                  {metric.label}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex items-end justify-between gap-3 p-4 pt-0">
                <span className="min-w-0 truncate text-2xl font-semibold">{metric.value}</span>
                <Badge variant={metric.tone}>{toneLabel[metric.tone]}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {document.focusItems.length > 0 ? (
        <section className="rounded-lg border border-border bg-card/45 p-4">
          <h2 className="text-sm font-semibold">Current focus</h2>
          <div className="mt-3 grid gap-2">
            {document.focusItems.map((item) => (
              <div
                key={item}
                className="flex min-h-10 items-center rounded-md border border-border/70 bg-background px-3 text-sm"
              >
                <span className="min-w-0 truncate">{item}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
