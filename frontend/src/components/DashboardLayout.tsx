import type { ReactNode } from 'react';
import type { AnalysisTab } from '../layoutState';

export function Sidebar({
  side,
  label,
  collapsed,
  onToggle,
  children,
}: {
  side: 'left' | 'right';
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <aside
      className={`dashboard-sidebar dashboard-sidebar--${side}${collapsed ? ' is-collapsed' : ''}`}
      aria-label={label}
    >
      <button
        type="button"
        className="sidebar-toggle"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        title={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        onClick={onToggle}
      >
        <span aria-hidden="true">{side === 'left' ? (collapsed ? '\u203a' : '\u2039') : (collapsed ? '\u2039' : '\u203a')}</span>
        <small>{collapsed ? 'Open' : 'Close'}</small>
      </button>
      {!collapsed && <div className="dashboard-sidebar__content">{children}</div>}
    </aside>
  );
}

export function PanelSection({
  title,
  meta,
  children,
  className = '',
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel-section ${className}`}>
      <div className="panel-section__heading">
        <h2>{title}</h2>
        {meta && <span>{meta}</span>}
      </div>
      {children}
    </section>
  );
}

const ANALYSIS_TABS: { id: AnalysisTab; label: string }[] = [
  { id: 'comparison', label: 'Engine comparison' },
  { id: 'maneuvers', label: 'Maneuvers' },
  { id: 'candidates', label: 'Candidate analysis' },
  { id: 'scenarios', label: 'Testcases' },
  { id: 'raw', label: 'Raw responses' },
];

export function AnalysisWorkspace({
  activeTab,
  collapsed,
  onSelectTab,
  onToggle,
  children,
}: {
  activeTab: AnalysisTab;
  collapsed: boolean;
  onSelectTab: (tab: AnalysisTab) => void;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`analysis-workspace${collapsed ? ' is-collapsed' : ''}`} aria-label="Analysis workspace">
      <div className="analysis-tabs" role="tablist" aria-label="Diagnostic views">
        {ANALYSIS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? 'is-active' : ''}
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          className="analysis-collapse"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} analysis workspace`}
          title={`${collapsed ? 'Expand' : 'Collapse'} analysis workspace`}
          onClick={onToggle}
        >
          <span aria-hidden="true">{collapsed ? '\u2303' : '\u2304'}</span>
        </button>
      </div>
      {!collapsed && <div className="analysis-workspace__body" role="tabpanel">{children}</div>}
    </section>
  );
}
