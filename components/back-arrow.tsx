/** A back arrow: points left, and right in Arabic (the reading direction). */
export default function BackArrow({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`${className} rtl:rotate-180`}
    >
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}
