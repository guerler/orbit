/** Olit's own system prompt sections, placed by olitFlavor.promptSections. */

/** What Olit's visualization tools act on, in the system prompt's Galaxy terminology. */
export const VISUALIZATION_TERM =
  "- **Visualization**: a viewer Galaxy opens on a dataset in the browser, such as a genome\n" +
  "  browser or a structure viewer. Visualizations are not tools and no tool search finds them:\n" +
  "  to open or view a dataset in a viewer, call `list_visualizations` with its id.";

/** Olit opened on a dataset names it, so a bare reference to "the dataset" resolves. */
export function seedDatasetBlock(datasetId?: string): string {
  if (!datasetId) {
    return "";
  }
  return (
    `## Starting dataset\n\n` +
    `The user started this conversation on dataset \`${datasetId}\`. Take it as the one they ` +
    `mean when they refer to a dataset without naming another, and call ` +
    `\`get_dataset_details\` for its columns and datatype before acting on it.`
  );
}
