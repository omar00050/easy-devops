import {
  Bell,
  Boxes,
  Globe2,
  Rocket,
  LayoutDashboard,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Manage',
    items: [
      {
        to: '/',
        label: 'Overview',
        title: 'Overview',
        description: 'The state of nginx, your domains and their certificates at a glance.',
        icon: LayoutDashboard,
      },
      {
        to: '/domains',
        label: 'Domains',
        title: 'Domains',
        description: 'Reverse-proxy hosts, their backends and their nginx configuration.',
        icon: Globe2,
      },
      {
        to: '/ssl',
        label: 'SSL certificates',
        title: 'SSL certificates',
        description: 'Issue and renew Let’s Encrypt certificates for your domains.',
        icon: ShieldCheck,
      },
      {
        to: '/nginx',
        label: 'Nginx',
        title: 'Nginx',
        description: 'Service status, configuration files and live logs.',
        icon: Server,
      },
      {
        to: '/deployments',
        label: 'Deployments',
        title: 'Deployments',
        description: 'Put a project from a git repository on this server and keep it deployed.',
        icon: Rocket,
      },
    ],
  },
  {
    label: 'Monitor',
    items: [
      {
        to: '/notifications',
        label: 'Notifications',
        title: 'Notifications',
        description: 'Delivery channels, test messages and recent events.',
        icon: Bell,
      },
      {
        to: '/processes',
        label: 'Processes',
        title: 'Processes',
        description: 'The Easy DevOps background service and your own PM2 apps.',
        icon: Boxes,
      },
      {
        to: '/logs',
        label: 'Logs',
        title: 'Logs',
        description: 'nginx access and error output as it is written.',
        icon: ScrollText,
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        to: '/settings',
        label: 'Settings',
        title: 'Settings',
        description: 'Access, authentication, Hub pairing and backup.',
        icon: Settings,
      },
    ],
  },
];

const ALL_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

export function findNavItem(pathname: string): NavItem | undefined {
  return ALL_ITEMS.find((item) =>
    item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`)
  );
}
