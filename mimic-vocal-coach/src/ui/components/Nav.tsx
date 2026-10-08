// App chrome: top bar (wordmark + desktop nav) and the phone tab bar. The phone bar has five tabs (Trainer, Studio, Results,
// Progress, More); Practice, Guide and Settings sit under More there. The desktop bar lists every page. CSS shows one or the
// other at the 720px breakpoint.

import { ROUTE_LABELS, routeHash, tabFor, TAB_ROUTES, TOP_ROUTES, type Route } from '../../state/routing';
import { Icon } from './Icon';

interface NavProps {
  route: Route;
  resultsEnabled: boolean;
}

function NavItems(props: NavProps & { variant: 'top' | 'tabs' }) {
  const routes = props.variant === 'tabs' ? TAB_ROUTES : TOP_ROUTES;
  // On a phone the More tab stands for Practice, Guide and Settings.
  const here = props.variant === 'tabs' ? tabFor(props.route) : props.route;
  return (
    <ul className={`nav-list nav-list--${props.variant}`}>
      {routes.map((r) => {
        const current = here === r;
        // Results is always a real link: with no Studio take yet it opens a page that says so and offers the Studio, instead of a dead
        // tab whose reason lives in a tooltip that touch screens never show. It is only drawn quieter, and says so to screen readers.
        const empty = r === 'results' && !props.resultsEnabled;
        return (
          <li key={r}>
            <a className="nav-link" href={routeHash(r)} aria-current={current ? 'page' : undefined} data-empty={empty ? 'true' : undefined}>
              {props.variant === 'tabs' && <Icon name={r} size={22} />}
              <span className="nav-label">{ROUTE_LABELS[r]}</span>
              {empty && <span className="visually-hidden"> (no take yet)</span>}
            </a>
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
        <a className="wordmark" href={routeHash('trainer')} aria-label="Mimic vocal coach, go to the Trainer">
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
