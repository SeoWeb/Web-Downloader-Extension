interface PermissionItemProps {
  direction: string;
  label: string;
  description: string;
}

export default function PermissionItem({
  direction,
  label,
  description,
}: PermissionItemProps) {
  return (
    <li
      className={`flex items-center gap-1 ${direction === "rtl" ? "flex-row-reverse" : ""}`}
    >
      <strong
        className={`flex items-center ${direction === "rtl" ? "flex-row-reverse" : ""}`}
      >
        {label}
        <span>:</span>
      </strong>
      <span>{description}</span>
    </li>
  );
}
