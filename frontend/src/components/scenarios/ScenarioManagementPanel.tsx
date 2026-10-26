import { TestcaseManagementSections, type TestcaseManagementProps } from './TestcaseManagementSections';

export type ScenarioManagementPanelProps = TestcaseManagementProps;

export function ScenarioManagementPanel(props: ScenarioManagementPanelProps) {
  return <section className="card scenarios-card"><TestcaseManagementSections {...props} /></section>;
}
