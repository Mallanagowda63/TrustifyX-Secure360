#!/usr/bin/env bash
# Network-level egress restriction for the Secure360 containers (defence in depth on top of
# the application SSRF guard in src/server/security/safe-fetch.ts).
#
# Containers on the `egress` bridge (br-tx-egress) may reach the public internet but NOT:
# private networks, loopback, link-local (cloud metadata 169.254.169.254), CGNAT,
# multicast/reserved space, or the host itself.
#
# Usage (as root, after `docker compose up` created the bridge):
#   sudo ./deploy/egress-firewall.sh apply
#   sudo ./deploy/egress-firewall.sh remove
# Persist with `netfilter-persistent save` (iptables-persistent package) or a systemd unit.
set -euo pipefail

BRIDGE="${BRIDGE:-br-tx-egress}"
CHAIN="TX-EGRESS"

V4_DENY=(
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12
  192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24
  203.0.113.0/24 224.0.0.0/4 240.0.0.0/4
)
V6_DENY=(::1/128 ::/128 ::ffff:0:0/96 64:ff9b::/96 2002::/16 fc00::/7 fe80::/10 ff00::/8 2001:db8::/32)

apply() {
  local subnet
  subnet="$(ip -4 -o addr show dev "$BRIDGE" | awk '{print $4}' | head -1)"
  [[ -n "$subnet" ]] || { echo "bridge $BRIDGE not found - start the stack first" >&2; exit 1; }

  iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"
  iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for net in "${V4_DENY[@]}"; do
    iptables -A "$CHAIN" -d "$net" -j REJECT --reject-with icmp-net-prohibited
  done
  iptables -A "$CHAIN" -j RETURN
  iptables -C DOCKER-USER -i "$BRIDGE" -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER -i "$BRIDGE" -j "$CHAIN"

  # Containers must not reach services listening on the host itself via the bridge gateway IP.
  local gw="${subnet%/*}"
  iptables -C INPUT -i "$BRIDGE" -d "$gw" -p tcp -m conntrack --ctstate NEW -j REJECT 2>/dev/null || iptables -I INPUT -i "$BRIDGE" -d "$gw" -p tcp -m conntrack --ctstate NEW -j REJECT

  if command -v ip6tables >/dev/null && ip6tables -L DOCKER-USER >/dev/null 2>&1; then
    ip6tables -N "$CHAIN" 2>/dev/null || ip6tables -F "$CHAIN"
    ip6tables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
    for net in "${V6_DENY[@]}"; do
      ip6tables -A "$CHAIN" -d "$net" -j REJECT
    done
    ip6tables -A "$CHAIN" -j RETURN
    ip6tables -C DOCKER-USER -i "$BRIDGE" -j "$CHAIN" 2>/dev/null || ip6tables -I DOCKER-USER -i "$BRIDGE" -j "$CHAIN"
  fi
  echo "Egress restrictions applied to $BRIDGE ($subnet)"
}

remove() {
  iptables -D DOCKER-USER -i "$BRIDGE" -j "$CHAIN" 2>/dev/null || true
  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
  local subnet gw
  subnet="$(ip -4 -o addr show dev "$BRIDGE" 2>/dev/null | awk '{print $4}' | head -1)"
  if [[ -n "$subnet" ]]; then
    gw="${subnet%/*}"
    iptables -D INPUT -i "$BRIDGE" -d "$gw" -p tcp -m conntrack --ctstate NEW -j REJECT 2>/dev/null || true
  fi
  if command -v ip6tables >/dev/null; then
    ip6tables -D DOCKER-USER -i "$BRIDGE" -j "$CHAIN" 2>/dev/null || true
    ip6tables -F "$CHAIN" 2>/dev/null || true
    ip6tables -X "$CHAIN" 2>/dev/null || true
  fi
  echo "Egress restrictions removed"
}

case "${1:-}" in
  apply) apply ;;
  remove) remove ;;
  *) echo "usage: $0 apply|remove" >&2; exit 2 ;;
esac
