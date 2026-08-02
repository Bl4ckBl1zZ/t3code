import { MOCK_HTML } from "../shared/mockHtml";

export function App() {
  return (
    <iframe
      srcDoc={MOCK_HTML}
      title="T3 Code Mobile — Automations UI draft"
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", border: "none" }}
    />
  );
}
