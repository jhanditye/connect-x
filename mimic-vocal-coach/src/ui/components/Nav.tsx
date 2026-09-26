// App chrome: top bar (wordmark + desktop nav) and the phone tab bar. Both render the same items;
// CSS shows one or the other at the 720px breakpoint.

import { ROUTES, ROUTE_LABELS, routeHash, type Route } from '../../state/routing';
import { Icon } from './Icon';

interface NavProps {
  route: Route;
  resultsEnabled: boolean;
}

function NavItems(props: NavProps & { variant: 'top' | 'tabs' }) {
  return (
    <ul className={`nav-list nav-list--${props.variant}`}>
      {ROUTES.map((r) => {
        const current = props.route === r;
        const disabled = r === 'results' && !props.resultsEnabled;
        const content = (
          <>
            {props.variant === 'tabs' && <Icon name={r} size={22} />}
            <span className="nav-label">{ROUTE_LABELS[r]}</span>
          </>
        );
        return (
          <li key={r}>
            {disabled ? (
              <a className="nav-link" aria-disabled="true" role="link" title="Analyse a take first">
                {content}
              </a>
            ) : (
              <a className="nav-link" href={routeHash(r)} aria-current={current ? 'page' : undefined}>
                {content}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function TopBar(props: NavProps) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="wordmark" href={routeHash('studio')} aria-label="Mimic vocal coach, go to the Studio">
          <span className="wordmark-name">Mimic</span>
          <span className="wordmark-sub">vocal coach</span>
        </a>
        <nav className="topnav" aria-label="Main">
          <NavItems {...props} variant="top" />
        </nav>
      </div>
    </header>
  );
}

export function TabBar(props: NavProps) {
  return (
    <nav className="tabbar" aria-label="Main">
      <NavItems {...props} variant="tabs" />
    </nav>
  );
}
