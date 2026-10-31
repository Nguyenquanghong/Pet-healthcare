// docker-compose.yml pins its network to PET_NET_PREFIX.0/24 so the API can trust the frontend by address. A test
// project is only stopped (its evidence stays), so its network lives on; each run must therefore pick a /24 that no
// existing Docker network overlaps, and set PET_NET_PREFIX to it in its private env file.
import { execFileSync } from 'node:child_process';

const toNumber = address => address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
export function usedRanges(docker = args => execFileSync('docker', args, { encoding: 'utf8' })) {
  const ids = docker(['network', 'ls', '-q']).split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const subnets = JSON.parse(docker(['network', 'inspect', ...ids])).flatMap(n => (n.IPAM?.Config ?? []).map(c => c.Subnet)).filter(s => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s ?? ''));
  return subnets.map(s => { const [address, bits] = s.split('/'), size = 2 ** (32 - Number(bits)), first = Math.floor(toNumber(address) / size) * size; return [first, first + size - 1]; });
}
// Three octets such as `10.231.57`, in 10.231.1.0 - 10.250.250.0, whose /24 touches no used range.
export function freeNetworkPrefix(used = usedRanges(), random = Math.random) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const second = 231 + Math.floor(random() * 20), third = 1 + Math.floor(random() * 250), first = toNumber(`10.${second}.${third}.0`);
    if (!used.some(([from, to]) => first <= to && from <= first + 255)) return `10.${second}.${third}`;
  }
  throw new Error('No free /24 found for the test network.');
}
