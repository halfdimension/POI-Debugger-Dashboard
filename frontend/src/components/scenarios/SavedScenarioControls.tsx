import { TestcaseManagementSections, type TestcaseManagementProps } from './TestcaseManagementSections';

export type SavedScenarioControlsProps = TestcaseManagementProps;

export function SavedScenarioControls(props: SavedScenarioControlsProps) {
  return <details className="sidebar-disclosure" open><summary><span>Testcases</span><small>{props.registry?.count ?? 0} mine · {props.registry?.shared_total ?? 0} shared</small></summary><div className="sidebar-disclosure__body"><TestcaseManagementSections {...props} /></div></details>;
}
