#!/usr/bin/env bash
# Baseline hardening for a fresh Debian/Ubuntu VPS before installing Pangolin.
# Usage (as root):
#   ADMIN_USER=admin SSH_PUBKEY="ssh-ed25519 AAAA... you@host" bash harden-vps.sh
# Optional: SSH_PORT=22  EXTRA_ALLOW_USERS="deploy"  (accounts that must keep SSH access, e.g. the CI deploy user)
#           REBOOT_TIME=04:00  (server-local time for automatic reboots after kernel/libc updates)
# Safe to re-run.
set -euo pipefail

: "${ADMIN_USER:?set ADMIN_USER, e.g. admin}"
: "${SSH_PUBKEY:?set SSH_PUBKEY to your public key line}"
SSH_PORT="${SSH_PORT:-22}"
EXTRA_ALLOW_USERS="${EXTRA_ALLOW_USERS:-}"
REBOOT_TIME="${REBOOT_TIME:-04:00}"
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# Password login is switched off below, so a mangled key would leave only the provider console. Fail first.
ssh-keygen -l -f /dev/stdin <<<"$SSH_PUBKEY" >/dev/null 2>&1 || { echo "SSH_PUBKEY is not a valid public key"; exit 1; }
# Ubuntu starts sshd through ssh.socket, which ignores `Port`; moving the port needs more than this script does.
if [ "$SSH_PORT" != 22 ] && systemctl is-active --quiet ssh.socket 2>/dev/null; then
  echo "SSH_PORT other than 22 is not supported while ssh.socket is active"; exit 1
fi

echo "== 1. updates + automatic security updates (with scheduled reboot)"
apt-get update -y
apt-get upgrade -y
apt-get install -y sudo ufw fail2ban unattended-upgrades chrony curl ca-certificates \
  auditd audispd-plugins aide lynis
dpkg-reconfigure -f noninteractive unattended-upgrades
# Kernel and libc fixes only take effect after a reboot. Containers must have restart: unless-stopped.
cat > /etc/apt/apt.conf.d/52unattended-upgrades-local <<EOF
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "$REBOOT_TIME";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

echo "== 2. admin user with key-only login"
id "$ADMIN_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$ADMIN_USER"
usermod -aG sudo "$ADMIN_USER"
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "/home/$ADMIN_USER/.ssh"
AK="/home/$ADMIN_USER/.ssh/authorized_keys"
grep -qxF "$SSH_PUBKEY" "$AK" 2>/dev/null || echo "$SSH_PUBKEY" >> "$AK"
chown "$ADMIN_USER:$ADMIN_USER" "$AK"; chmod 600 "$AK"
# the account has no password, so sudo is passwordless; the SSH key is the credential
echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$ADMIN_USER"
chmod 440 "/etc/sudoers.d/90-$ADMIN_USER"; visudo -cf "/etc/sudoers.d/90-$ADMIN_USER"

echo "== 3. sshd lockdown (validated before reload)"
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<EOF
Port $SSH_PORT
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowUsers $ADMIN_USER $EXTRA_ALLOW_USERS
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
sshd -t
systemctl reload ssh || systemctl reload sshd
echo "   KEEP THIS SESSION OPEN. In a second terminal confirm: ssh $ADMIN_USER@<ip>"

echo "== 4. firewall (Pangolin: 80, 443, WireGuard 51820/udp, 21820/udp)"
ufw default deny incoming
ufw default allow outgoing
ufw allow "$SSH_PORT"/tcp comment ssh
ufw allow 80/tcp comment http
ufw allow 443/tcp comment https
ufw allow 51820/udp comment gerbil-wireguard
ufw allow 21820/udp comment gerbil-clients

# Docker publishes ports through its own iptables rules, which skip ufw's INPUT rules. The DOCKER-USER block
# below (the ufw-docker approach) drops new connections from outside to any container address unless a
# `ufw route allow` rule names the port. Rules match the container port (after DNAT); Pangolin's default
# compose uses the same numbers as the host ports. Add a route rule for anything else you mean to expose.
# Known limits: sources inside RFC1918 are trusted (fine on a host with only a public NIC; on a provider LAN,
# match the public interface instead); established replies are returned by conntrack; IPv4 only, so add the
# same block to /etc/ufw/after6.rules before enabling Docker IPv6 (Pangolin's compose sets enable_ipv6).
if ! grep -q "BEGIN UFW AND DOCKER" /etc/ufw/after.rules; then
  cat >> /etc/ufw/after.rules <<'EOF'

# BEGIN UFW AND DOCKER
*filter
:ufw-user-forward - [0:0]
:ufw-docker-logging-deny - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -j ufw-user-forward

-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

-A DOCKER-USER -j RETURN -s 10.0.0.0/8
-A DOCKER-USER -j RETURN -s 172.16.0.0/12
-A DOCKER-USER -j RETURN -s 192.168.0.0/16

-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 192.168.0.0/16
-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 10.0.0.0/8
-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 172.16.0.0/12
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -d 192.168.0.0/16
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -d 10.0.0.0/8
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -d 172.16.0.0/12

-A DOCKER-USER -j RETURN

-A ufw-docker-logging-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW DOCKER BLOCK] "
-A ufw-docker-logging-deny -j DROP

COMMIT
# END UFW AND DOCKER
EOF
fi
ufw route allow proto tcp from any to any port 80 comment 'docker http'
ufw route allow proto tcp from any to any port 443 comment 'docker https'
ufw route allow proto udp from any to any port 51820 comment 'docker gerbil-wireguard'
ufw route allow proto udp from any to any port 21820 comment 'docker gerbil-clients'
ufw --force enable
ufw reload

echo "== 5. fail2ban for sshd"
cat > /etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled = true
port = $SSH_PORT
maxretry = 4
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

echo "== 6. kernel network hardening (ip_forward untouched: Docker/Pangolin need it)"
cat > /etc/sysctl.d/99-hardening.conf <<EOF
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.log_martians = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
EOF
# a key the kernel rejects (e.g. an ipv6 knob with IPv6 off) must not stop the remaining steps
sysctl --system >/dev/null || echo "   warning: sysctl --system reported an error; check 'sysctl --system'"

echo "== 7. time sync"
systemctl enable --now chrony

echo "== 8. audit trail (auditd) and persistent journal"
cat > /etc/audit/rules.d/99-hardening.rules <<'EOF'
# identity, authentication and privilege changes
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/sudoers -p wa -k privilege
-w /etc/sudoers.d/ -p wa -k privilege
# ssh and firewall configuration
-w /etc/ssh/sshd_config -p wa -k sshd
-w /etc/ssh/sshd_config.d/ -p wa -k sshd
-w /etc/ufw/ -p wa -k firewall
# scheduled jobs and services (common persistence points)
-w /etc/crontab -p wa -k cron
-w /etc/cron.d/ -p wa -k cron
-w /var/spool/cron/ -p wa -k cron
-w /etc/systemd/system/ -p wa -k systemd
-w /usr/lib/systemd/system/ -p wa -k systemd
# time changes and kernel module loading (32-bit compat syscalls too)
-a always,exit -F arch=b64 -S adjtimex,settimeofday,clock_settime -k time
-a always,exit -F arch=b32 -S adjtimex,settimeofday,clock_settime -k time
-a always,exit -F arch=b64 -S init_module,finit_module,delete_module -k modules
-a always,exit -F arch=b32 -S init_module,finit_module,delete_module -k modules
# commands run as root by a logged-in human (auid is the original login uid; unset for daemons)
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -F auid!=unset -k rootcmd
-a always,exit -F arch=b32 -S execve -F euid=0 -F auid>=1000 -F auid!=unset -k rootcmd
EOF
# a watch on a missing path makes auditctl reject the file, so add Docker's only once it is installed
for p in /etc/docker /usr/bin/dockerd; do
  [ -e "$p" ] && echo "-w $p -p wa -k docker" >> /etc/audit/rules.d/99-hardening.rules
done
systemctl enable auditd
augenrules --load || echo "   warning: augenrules --load failed; check 'auditctl -l'"
[ "$(auditctl -l 2>/dev/null | grep -c -E 'k (identity|privilege|sshd|firewall|cron|systemd|time|modules|rootcmd)$')" -gt 0 ] \
  || echo "   warning: no hardening audit rules are loaded"
install -d /var/log/journal
sed -i -E 's/^#?Storage=.*/Storage=persistent/; s/^#?SystemMaxUse=.*/SystemMaxUse=500M/' /etc/systemd/journald.conf
grep -q '^Storage=persistent' /etc/systemd/journald.conf || printf '[Journal]\nStorage=persistent\nSystemMaxUse=500M\n' >> /etc/systemd/journald.conf
systemctl restart systemd-journald

echo "== 9. file-integrity baseline (AIDE, checked daily by the packaged timer)"
if [ ! -f /var/lib/aide/aide.db ]; then
  (aideinit -y -f && cp /var/lib/aide/aide.db.new /var/lib/aide/aide.db) || echo "   aide baseline failed; run aideinit by hand"
fi
systemctl enable --now dailyaidecheck.timer 2>/dev/null || true

echo "== 10. lynis baseline report"
lynis audit system --quiet --no-colors --report-file /root/lynis-report.dat > /root/lynis-baseline.txt 2>&1 || true
grep -E "Hardening index" /root/lynis-baseline.txt || true

echo "== done. Verify:"
echo "   ufw status verbose; fail2ban-client status sshd; sshd -T | grep -Ei 'permitroot|passwordauth|allowusers'"
echo "   auditctl -l | head; aide --check | head; grep -E 'Automatic-Reboot' /etc/apt/apt.conf.d/52unattended-upgrades-local"
echo "   After Pangolin is up, from another machine: nmap -Pn -p- <this-host-ip>  (only 22, 80, 443 should answer; 51820/21820 are UDP)"
echo "   The AIDE baseline predates Docker/Pangolin: run 'aideinit -y -f && cp /var/lib/aide/aide.db.new /var/lib/aide/aide.db' once the stack is installed."
echo "   Re-run this script after installing Docker so its audit watches are added."
echo "   Review /root/lynis-baseline.txt for further suggestions."
