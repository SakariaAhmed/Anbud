/** Preserve the saved four-track order while showing evidence with trust. */
export function customerAnalysisPositioningGroups(items: string[]) {
  const groups = [
    { title: "Budskap", items: [] as string[] },
    { title: "Trygghet", items: [] as string[] },
    { title: "Leveranse", items: [] as string[] },
  ];
  const savedTrackToGroup = [0, 1, 1, 2] as const;
  items.forEach((item, index) => {
    groups[savedTrackToGroup[index % savedTrackToGroup.length]].items.push(item);
  });
  return groups;
}
