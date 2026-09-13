const FONT_FAMILIES = {
  regular: "IBMPlexSans-Regular",
  medium: "IBMPlexSans-Medium",
  bold: "IBMPlexSans-Bold",
} as const;

/**
 * Resolves a font family for APIs that require a style object or native prop.
 * Prefer Uniwind font classes when the target component accepts `className`.
 */
export function useFontFamily(weight: keyof typeof FONT_FAMILIES): string {
  return FONT_FAMILIES[weight];
}
