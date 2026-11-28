"use client";

/**
 * Brand switcher at the bottom of the sidebar. With a single workspace it is
 * just the workspace name, as before. With several it becomes a select; a
 * switch stores the choice server-side and reloads, so every page, client
 * caches included, starts over in the new brand.
 */
import { useEffect, useState, useTransition } from "react";
import { selectWorkspace } from "@/lib/agency/actions";
import { useFbI18n } from "@/lib/facebook/i18n/client";

type WorkspaceOption = { id: string; name: string };

export default function WorkspaceSwitcher({ currentName }: { currentName: string }) {
  const { t } = useFbI18n();
  const [options, setOptions] = useState<WorkspaceOption[]>([]);
  const [activeId, setActiveId] = useState("");
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agency/workspaces", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled || !payload?.success) return;
        setOptions(payload.data.workspaces);
        setActiveId(payload.data.activeWorkspaceId ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (options.length < 2) {
    return <p className="truncate text-sm text-foreground">{currentName}</p>;
  }

  return (
    <div className="space-y-1">
      <label className="block">
        <span className="sr-only">{t("Switch brand")}</span>
        <select
          value={activeId}
          disabled={pending}
          aria-busy={pending}
          onChange={(event) => {
            const next = event.target.value;
            setFailed(false);
            startTransition(async () => {
              const result = await selectWorkspace(next).catch(() => null);
              if (result?.ok) {
                window.location.reload();
              } else {
                setFailed(true);
              }
            });
          }}
          className="min-h-9 w-full truncate rounded border border-border bg-surface px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
      {failed && (
        <p role="alert" className="text-xs text-error">
          {t("Could not switch brand. Please try again.")}
        </p>
      )}
    </div>
  );
}
