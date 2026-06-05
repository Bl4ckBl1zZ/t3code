import type { WorkbenchTab } from "@t3tools/client-runtime";
import {
  CopyIcon,
  ExternalLinkIcon,
  LocateIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
} from "lucide-react";
import type * as Monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import "monaco-editor/min/vs/editor/editor.main.css";

import { openInPreferredEditor } from "../../editorPreferences";
import { useTheme } from "../../hooks/useTheme";
import { readLocalApi } from "../../localApi";
import {
  useWorkspaceDocument,
  workspaceDocumentManager,
  type WorkspaceDocumentTarget,
} from "../../lib/workspaceFileState";
import { cn } from "../../lib/utils";
import { useWorkbenchStore } from "../../workbenchStore";
import { Button } from "../ui/button";

type MonacoModule = typeof Monaco;
type MonacoEditor = ReturnType<MonacoModule["editor"]["create"]>;
type MonacoViewState = ReturnType<MonacoEditor["saveViewState"]>;

const editorViewStateByTabId = new Map<string, MonacoViewState>();

interface WorkspaceFileEditorProps {
  readonly tab: Extract<WorkbenchTab, { kind: "file" }>;
  readonly onDirtyChange: (tabId: string, dirty: boolean) => void;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  css: "css",
  html: "html",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  sh: "shell",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
};

function languageFromPath(relativePath: string): string {
  const basename = relativePath.split("/").pop() ?? relativePath;
  if (basename === "Dockerfile") return "dockerfile";
  const extension = basename.includes(".") ? basename.split(".").pop()?.toLowerCase() : "";
  return extension ? (LANGUAGE_BY_EXTENSION[extension] ?? "plaintext") : "plaintext";
}

function absoluteFilePath(cwd: string, relativePath: string): string {
  return `${cwd.replace(/\/+$/g, "")}/${relativePath.replace(/^\/+/g, "")}`;
}

function EditorStatusMessage({
  title,
  description,
  className,
}: {
  readonly title: string;
  readonly description?: string | null;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex h-full items-center justify-center p-6", className)}>
      <div className="max-w-md text-center">
        <div className="text-sm font-medium">{title}</div>
        {description ? (
          <div className="mt-2 text-xs leading-5 text-muted-foreground">{description}</div>
        ) : null}
      </div>
    </div>
  );
}

export function WorkspaceFileEditor({ tab, onDirtyChange }: WorkspaceFileEditorProps) {
  const target = useMemo<WorkspaceDocumentTarget>(
    () => ({
      environmentId: tab.environmentId,
      cwd: tab.cwd,
      relativePath: tab.relativePath,
    }),
    [tab.cwd, tab.environmentId, tab.relativePath],
  );
  const documentState = useWorkspaceDocument(target);
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const applyingRemoteValueRef = useRef(false);
  const latestDocumentStateRef = useRef(documentState);
  const [monacoReady, setMonacoReady] = useState(false);
  const [monacoError, setMonacoError] = useState<string | null>(null);
  const revealFileInExplorer = useWorkbenchStore((store) => store.revealFileInExplorer);

  const editable =
    documentState.status === "ready" ||
    documentState.status === "saving" ||
    documentState.status === "conflict";
  const canSave =
    editable &&
    documentState.dirty &&
    !documentState.readonly &&
    !documentState.binary &&
    !documentState.tooLarge;
  const editorCanMount = editable && documentState.draftContents !== null;

  const save = useCallback(
    (options?: { readonly overwrite?: boolean }) => {
      void workspaceDocumentManager.save(target, options).then((nextState) => {
        onDirtyChange(tab.id, nextState.dirty);
      });
    },
    [onDirtyChange, tab.id, target],
  );

  useEffect(() => {
    latestDocumentStateRef.current = documentState;
  }, [documentState]);

  useEffect(() => {
    onDirtyChange(tab.id, documentState.dirty);
  }, [documentState.dirty, onDirtyChange, tab.id]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    if (!containerRef.current || !editorCanMount) {
      return undefined;
    }
    const initialDocumentState = latestDocumentStateRef.current;
    if (initialDocumentState.draftContents === null) {
      return undefined;
    }
    const initialContents = initialDocumentState.draftContents;

    void import("monaco-editor/esm/vs/editor/editor.api.js")
      .then((monacoModule) => {
        const monaco = monacoModule as unknown as MonacoModule;
        if (disposed || !containerRef.current) return;
        monacoRef.current = monaco;
        const model = monaco.editor.createModel(
          initialContents,
          languageFromPath(tab.relativePath),
          monaco.Uri.file(absoluteFilePath(tab.cwd, tab.relativePath)),
        );
        const editor = monaco.editor.create(containerRef.current, {
          model,
          automaticLayout: true,
          fontFamily:
            '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 13,
          minimap: { enabled: false },
          readOnly: initialDocumentState.readonly || initialDocumentState.status === "saving",
          scrollBeyondLastLine: false,
          tabSize: 2,
          theme: resolvedTheme === "dark" ? "vs-dark" : "vs",
        });
        const viewState = editorViewStateByTabId.get(tab.id);
        if (viewState) {
          editor.restoreViewState(viewState);
        }
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          save();
        });
        const changeSubscription = editor.onDidChangeModelContent(() => {
          if (applyingRemoteValueRef.current) return;
          workspaceDocumentManager.edit(target, editor.getValue());
        });
        editorRef.current = editor;
        setMonacoReady(true);
        cleanup = () => {
          editorViewStateByTabId.set(tab.id, editor.saveViewState());
          changeSubscription.dispose();
          editor.dispose();
          model.dispose();
          if (editorRef.current === editor) {
            editorRef.current = null;
          }
        };
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setMonacoError(error instanceof Error ? error.message : "Failed to load editor.");
        }
      });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [editorCanMount, resolvedTheme, save, tab.cwd, tab.id, tab.relativePath, target]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || documentState.draftContents === null) {
      return;
    }
    if (editor.getValue() === documentState.draftContents) {
      return;
    }
    applyingRemoteValueRef.current = true;
    editor.setValue(documentState.draftContents);
    applyingRemoteValueRef.current = false;
  }, [documentState.draftContents]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    monaco.editor.setTheme(resolvedTheme === "dark" ? "vs-dark" : "vs");
  }, [resolvedTheme]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({
      readOnly: documentState.readonly || documentState.status === "saving",
    });
  }, [documentState.readonly, documentState.status]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const saveShortcut = isMac
        ? event.metaKey && event.key === "s"
        : event.ctrlKey && event.key === "s";
      if (!saveShortcut) return;
      event.preventDefault();
      if (canSave) save();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canSave, save]);

  const copyRelativePath = useCallback(() => {
    void navigator.clipboard?.writeText(tab.relativePath);
  }, [tab.relativePath]);

  const openExternally = useCallback(() => {
    const api = readLocalApi();
    if (!api) return;
    void openInPreferredEditor(api, absoluteFilePath(tab.cwd, tab.relativePath)).catch((error) => {
      window.alert(error instanceof Error ? error.message : "Failed to open external editor.");
    });
  }, [tab.cwd, tab.relativePath]);

  const revealInExplorer = useCallback(() => {
    revealFileInExplorer({
      environmentId: tab.environmentId,
      cwd: tab.cwd,
      relativePath: tab.relativePath,
    });
  }, [revealFileInExplorer, tab.cwd, tab.environmentId, tab.relativePath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-testid="workspace-file-editor">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {tab.relativePath}
            {documentState.dirty ? <span className="ml-1 text-muted-foreground">*</span> : null}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{tab.cwd}</div>
        </div>
        <Button size="xs" variant="ghost" disabled={!canSave} onClick={() => save()}>
          <SaveIcon className="size-3.5" />
          Save
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!documentState.dirty}
          onClick={() => {
            workspaceDocumentManager.revert(target);
            onDirtyChange(tab.id, false);
          }}
        >
          <RotateCcwIcon className="size-3.5" />
          Revert
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            void workspaceDocumentManager.reload(target);
          }}
        >
          <RefreshCwIcon className="size-3.5" />
          Reload
        </Button>
        <Button size="xs" variant="ghost" onClick={openExternally}>
          <ExternalLinkIcon className="size-3.5" />
          Open
        </Button>
        <Button size="xs" variant="ghost" onClick={copyRelativePath}>
          <CopyIcon className="size-3.5" />
          Copy
        </Button>
        <Button size="xs" variant="ghost" onClick={revealInExplorer}>
          <LocateIcon className="size-3.5" />
          Reveal
        </Button>
      </div>

      {documentState.externalChange && documentState.status !== "conflict" ? (
        <div className="flex min-h-8 shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/8 px-3 text-xs text-warning-foreground">
          <span className="min-w-0 flex-1 truncate">File changed on disk.</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void workspaceDocumentManager.reload(target)}
          >
            Reload
          </Button>
        </div>
      ) : null}

      {documentState.status === "conflict" ? (
        <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/8 px-3 text-xs">
          <span className="min-w-0 flex-1 truncate">Save conflict. Your draft is preserved.</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void workspaceDocumentManager.reload(target)}
          >
            Reload disk
          </Button>
          <Button size="xs" variant="ghost" onClick={() => save({ overwrite: true })}>
            Overwrite disk
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {documentState.status === "loading" || documentState.status === "idle" ? (
          <EditorStatusMessage title="Loading file" />
        ) : documentState.status === "deleted" ? (
          <EditorStatusMessage
            title="File deleted"
            description={
              documentState.dirty
                ? "The file was deleted on disk. Your unsaved draft is still in memory."
                : "Reload the Explorer to refresh the file list."
            }
          />
        ) : documentState.status === "unsupported" ? (
          <EditorStatusMessage title="Cannot edit this file" description={documentState.error} />
        ) : documentState.status === "error" ? (
          <EditorStatusMessage title="File error" description={documentState.error} />
        ) : monacoError ? (
          <EditorStatusMessage title="Editor failed to load" description={monacoError} />
        ) : (
          <div
            ref={containerRef}
            className={cn("h-full min-h-0 w-full", !monacoReady && "opacity-0")}
          />
        )}
      </div>
    </div>
  );
}
