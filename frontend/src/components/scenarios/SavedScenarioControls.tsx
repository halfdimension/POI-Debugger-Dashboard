import type { TestcaseTab } from './TestcaseManagementSections';

export interface SavedScenarioControlsProps {
  mineCount: number;
  sharedCount: number;
  legacyCount: number;
  onOpen: (tab: TestcaseTab) => void;
}

export function SavedScenarioControls({ mineCount, sharedCount, legacyCount, onOpen }: SavedScenarioControlsProps) {
  return (
    <section className="testcase-entry" aria-labelledby="testcase-entry-title">
      <div className="panel-section__heading">
        <h2 id="testcase-entry-title">Testcase library</h2>
        <span>{mineCount + sharedCount + legacyCount}</span>
      </div>
      <p>Manage and execute testcases in the full-width analysis workspace.</p>
      <div className="testcase-entry__actions">
        <button type="button" onClick={() => onOpen('mine')}>My Testcases <span>{mineCount}</span></button>
        <button type="button" onClick={() => onOpen('shared')}>Shared <span>{sharedCount}</span></button>
        <button type="button" onClick={() => onOpen('legacy')}>Legacy <span>{legacyCount}</span></button>
      </div>
    </section>
  );
}
