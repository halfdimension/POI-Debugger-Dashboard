import { TestcaseManagementSections, type TestcaseManagementSectionsProps } from './TestcaseManagementSections';

export type ScenarioManagementPanelProps = TestcaseManagementSectionsProps;

export function ScenarioManagementPanel(props: ScenarioManagementPanelProps) {
  return <section className="card scenarios-card"><TestcaseManagementSections {...props} /></section>;
}
