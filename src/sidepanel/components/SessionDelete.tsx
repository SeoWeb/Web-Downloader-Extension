import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckedState } from "@radix-ui/react-checkbox";
import { Cloud, Loader2, Trash2 } from "lucide-react";
import { Button } from "../../components/Button";
import { Checkbox } from "../../components/Checkbox";

/**
 * Panel delete flow for server sessions (close-cloud-lifecycle-gaps D2).
 *
 * "Delete server copy" reveals a confirmation step; for cloud-success
 * sessions it carries the opt-in "Also remove from PagePocket" checkbox.
 * The checkbox defaults to OFF — a local delete must never silently
 * destroy cloud data the user may still want — and is rendered ONLY for
 * sessions whose server-side cloud push succeeded (`cloud_status ==
 * "success"`, which the panel tracks via the cloud upload state).
 *
 * The delete itself is delegated to `onDelete` so the transport wiring
 * (background message) stays outside this component.
 */

interface SessionDeleteProps {
  /**
   * Server-side cloud status of the session (`SessionStatusResponse.cloud_status`).
   * The "Also remove from PagePocket" option is offered only for "success".
   */
  cloudStatus?: string | null;
  /** Called on confirm with the checkbox state. */
  onDelete: (options: { deleteCloud: boolean }) => Promise<void> | void;
}

type DeletePhase = "idle" | "confirm" | "deleting" | "deleted";

export function SessionDelete({ cloudStatus, onDelete }: SessionDeleteProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<DeletePhase>("idle");
  const [deleteCloud, setDeleteCloud] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Opt-in federated delete: offered only for cloud-success sessions.
  const showCloudOption = cloudStatus === "success";

  const handleCheckedChange = (checked: CheckedState) => {
    setDeleteCloud(!!checked);
  };

  const handleConfirm = async () => {
    setPhase("deleting");
    setError(null);
    try {
      await onDelete({ deleteCloud });
      setPhase("deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("confirm");
    }
  };

  if (phase === "deleted") {
    return (
      <p className="text-sm text-green-700 flex items-center gap-1.5">
        <Cloud className="w-4 h-4" />
        {t("sessionDelete.deleted")}
      </p>
    );
  }

  if (phase === "idle") {
    return (
      <button
        onClick={() => setPhase("confirm")}
        className="text-sm text-slate-500 hover:text-red-600 flex items-center gap-1.5 cursor-pointer transition-colors"
      >
        <Trash2 className="w-4 h-4" />
        {t("sessionDelete.deleteButton")}
      </button>
    );
  }

  // confirm / deleting / retry-after-error
  return (
    <div className="w-full bg-red-50 border border-red-200 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Trash2 className="w-4 h-4 text-red-500 flex-shrink-0" />
        <p className="text-sm font-medium text-red-900">
          {t("sessionDelete.confirmTitle")}
        </p>
      </div>
      <p className="text-xs text-red-700">{t("sessionDelete.confirmNote")}</p>

      {showCloudOption && (
        <div className="flex items-center gap-2">
          <Checkbox
            id="sessionDeleteCloud"
            checked={deleteCloud}
            onCheckedChange={handleCheckedChange}
          />
          <label
            htmlFor="sessionDeleteCloud"
            className="text-xs text-slate-700 cursor-pointer"
          >
            {t("sessionDelete.alsoRemoveFromPagepocket")}
          </label>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-700">
          {t("sessionDelete.deleteFailed", { error })}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          onClick={handleConfirm}
          variant="destructive"
          size="sm"
          disabled={phase === "deleting"}
          className="flex items-center gap-1.5"
        >
          {phase === "deleting" ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Trash2 className="w-4 h-4" />
          )}
          {t("sessionDelete.confirmDelete")}
        </Button>
        <Button
          onClick={() => {
            setPhase("idle");
            setDeleteCloud(false);
            setError(null);
          }}
          variant="secondary"
          size="sm"
          disabled={phase === "deleting"}
        >
          {t("sessionDelete.cancel")}
        </Button>
      </div>
    </div>
  );
}
