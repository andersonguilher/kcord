#!/usr/bin/env bash
# Recreates Docker Compose projects whose bridge network lost its NAT/FORWARD
# rules. A Docker upgrade on 2026-10-31 restarted the daemon and left some
# networks without them, so their containers had no internet access.
#
# Usage: kcord-docker-network-repair.sh [--dry-run] [--wait SECONDS]
set -u

dry_run=false
wait_seconds=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --wait) wait_seconds="${2:-0}"; shift ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done

# Containers with a restart policy come back a little after the daemon starts.
if [ "$wait_seconds" -gt 0 ]; then sleep "$wait_seconds"; fi

if ! iptables -n -L DOCKER-FORWARD >/dev/null 2>&1; then
  echo "Cadeia DOCKER-FORWARD ausente: o Docker pode estar usando outro backend de firewall. Nada a fazer."
  exit 0
fi

# Prints the bridge networks whose IPv4 rules are missing, one "id name" per line.
broken_networks() {
  docker network ls --filter driver=bridge --format '{{.ID}} {{.Name}}' | while read -r id name; do
    internal=$(docker network inspect "$id" --format '{{.Internal}}')
    masquerade=$(docker network inspect "$id" --format '{{index .Options "com.docker.network.bridge.enable_ip_masquerade"}}')
    [ "$internal" = "true" ] && continue
    [ "$masquerade" = "false" ] && continue
    bridge=$(docker network inspect "$id" --format '{{index .Options "com.docker.network.bridge.name"}}')
    [ -n "$bridge" ] || bridge="br-${id:0:12}"
    ip link show "$bridge" >/dev/null 2>&1 || continue
    missing=false
    for subnet in $(docker network inspect "$id" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'); do
      case "$subnet" in *:*) continue ;; esac
      iptables -t nat -C POSTROUTING -s "$subnet" ! -o "$bridge" -j MASQUERADE 2>/dev/null || missing=true
    done
    iptables -C DOCKER-FORWARD -i "$bridge" -j ACCEPT 2>/dev/null || missing=true
    if [ "$missing" = true ]; then echo "$id $name"; fi
  done
}

broken=$(broken_networks)
if [ -z "$broken" ]; then
  echo "Todas as redes Docker têm as regras de saída."
  exit 0
fi

# Maps each broken network to the Compose projects of the containers on it.
declare -A projects=()
while read -r id name; do
  echo "Rede sem regras de saída: $name ($id)"
  for container in $(docker network inspect "$id" --format '{{range $cid, $c := .Containers}}{{$cid}} {{end}}'); do
    project=$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project"}}')
    container_name=$(docker inspect "$container" --format '{{.Name}}')
    if [ -z "$project" ]; then
      echo "  ${container_name#/} não é de um projeto Compose; recrie manualmente."
      continue
    fi
    workdir=$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
    files=$(docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
    projects["$project"]="$workdir|$files"
  done
done <<< "$broken"

status=0
for project in "${!projects[@]}"; do
  workdir="${projects[$project]%%|*}"
  files="${projects[$project]#*|}"
  args=(-p "$project")
  IFS=',' read -r -a file_list <<< "$files"
  for file in "${file_list[@]}"; do args+=(-f "$file"); done
  if [ "$dry_run" = true ]; then
    echo "Recriaria o projeto $project: (cd $workdir && docker compose ${args[*]} down && docker compose ${args[*]} up -d)"
    continue
  fi
  echo "Recriando o projeto $project em $workdir"
  if (cd "$workdir" && docker compose "${args[@]}" down && docker compose "${args[@]}" up -d); then
    echo "Projeto $project recriado."
  else
    echo "Falha ao recriar o projeto $project." >&2
    status=1
  fi
done

if [ "$dry_run" = false ]; then
  remaining=$(broken_networks)
  if [ -n "$remaining" ]; then
    echo "Ainda sem regras de saída após o reparo:" >&2
    echo "$remaining" >&2
    status=1
  fi
fi
exit "$status"
