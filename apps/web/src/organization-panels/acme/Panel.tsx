import type { OrganizationPanelProps } from "../_shared/types";

export default function Panel({ organization }: OrganizationPanelProps) {
  return (
    <section className="flex flex-col gap-3 p-6">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Organization panel
      </p>
      <h1 className="text-xl font-semibold">{organization.name}</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">
        Acme has a dedicated editable panel file.
      </p>
    </section>
  );
}
