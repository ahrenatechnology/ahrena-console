"""Spike #106: mede como as contas aparecem no disco, só com contagens.

Lê, sem escrever nada, o índice de sessões do Claude Desktop e os transcripts do
Claude Code. Não imprime UUIDs, e-mails, nomes nem caminhos: só números e nomes de campo.
Rode com `python3 -I spikes/multiplas-contas/medir.py`.
"""

import collections
import glob
import json
import os

DESKTOP = os.path.expanduser('~/Library/Application Support/Claude/claude-code-sessions')
PROJECTS = os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR', '~/.claude') + '/projects')


def ler(caminho):
    try:
        with open(caminho) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


pastas = collections.Counter()
por_sessao = collections.defaultdict(set)
ssh = 0
arquivos = 0
for f in glob.glob(f'{DESKTOP}/*/*/local_*.json'):
    conta, org = f.split(os.sep)[-3:-1]
    d = ler(f)
    if d is None:
        continue
    arquivos += 1
    pastas[(conta, org)] += 1
    ssh += bool(d.get('sshConfig'))
    for sid in [d.get('cliSessionId'), *(d.get('priorCliSessionIds') or [])]:
        if sid:
            por_sessao[sid].add((conta, org))

contas = {c for c, _ in pastas}
print(f'Desktop: {len(contas)} contas, {len(pastas)} pastas conta/org, {arquivos} local_*.json, {ssh} por SSH')
print('  sessões por pasta conta/org:', sorted(pastas.values(), reverse=True))
print(f'  cliSessionId distintos: {len(por_sessao)}; em mais de uma pasta: {sum(len(v) > 1 for v in por_sessao.values())}')

transcripts = glob.glob(f'{PROJECTS}/*/*.jsonl')
resultado = collections.Counter()
for f in transcripts:
    sid = os.path.basename(f)[:-6]
    donos = set()
    with open(f, errors='ignore') as linhas:
        for linha in linhas:
            if '"bridge-session"' not in linha:
                continue
            try:
                d = json.loads(linha)
            except ValueError:
                continue
            donos.add((d.get('ownerAccountUuid'), d.get('ownerOrganizationUuid')))
    resultado['com bridge-session' if donos else 'sem bridge-session'] += 1
    if sid in por_sessao:
        resultado['ligados ao Desktop'] += 1
        if donos:
            resultado['dono entre as pastas do Desktop' if donos & por_sessao[sid] else 'dono fora das pastas do Desktop'] += 1
print(f'Transcripts: {len(transcripts)}', dict(resultado))
