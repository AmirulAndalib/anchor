export function draftTitle(title: string): string {
  return title.trim() ? title : "";
}

export function hasTitle(title: string | null | undefined): title is string {
  return !!title?.trim();
}
