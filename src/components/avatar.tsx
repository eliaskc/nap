import { COLOR_VALUES, SHAPE_PATHS, initials, type Look } from "~/lib/looks";
import { cn } from "~/lib/utils";

/** A person as their shape, in their colour, with their initials. */
export function Avatar({
  look,
  name,
  size = 32,
  className,
  letters = true,
}: {
  look: Look;
  name: string;
  size?: number;
  className?: string;
  letters?: boolean;
}) {
  const { d, text } = SHAPE_PATHS[look.shape];
  const [y, fontSize] = text;
  const label = initials(name);
  const fill = COLOR_VALUES[look.color];
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn("block shrink-0 overflow-visible", className)}
      role="img"
      aria-label={name}
      data-raster-avatar={`${look.shape}|${fill}|${letters ? label : ""}`}
    >
      <path d={d} fill={fill} />
      {letters && (
        <text
          x="50"
          y={y}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#fff"
          fontWeight={700}
          fontSize={label.length > 1 ? fontSize : fontSize * 1.2}
          style={{ fontFamily: "inherit" }}
        >
          {label}
        </text>
      )}
    </svg>
  );
}
