// Format labels only: category IDs and original names remain intact for API filters.
export function categoryLabel(value) {
  return String(value ?? "")
    .replace(/[#*0-9]\uFE0F?\u20E3/gu, " ")
    .replace(
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\p{So}\p{Co}]/gu,
      " ",
    )
    .replace(/[\u200D\uFE0E\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
