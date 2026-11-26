// The Amitec Reply mark: a speech bubble with its tail at the bottom left,
// the reply. (OpenReply's own mark belongs to that project: app/brand.)
export const LOGO_PATH =
  "M12 10h38a8 8 0 0 1 8 8v22a8 8 0 0 1-8 8H28l-12 11v-11h-4a8 8 0 0 1-8-8V18a8 8 0 0 1 8-8Z";
export const LOGO_VIEWBOX = "2 6 58 56";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={LOGO_VIEWBOX}
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path fillRule="evenodd" d={LOGO_PATH} />
    </svg>
  );
}
