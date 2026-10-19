// Gerado por packages/nucleo/test/api/gravar-cenarios.ts: a resposta de /api/painel em cada cenário
// do simulador (P1 a P7), com a hora fixa AGORA. Não edite: rode o script de novo.
import type { Painel } from '../types'

export const AGORA = 1793620800000

export const CENARIOS: Record<'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7', Painel> = {
  "p1": {
    "versao": 1,
    "geradoEm": "2026-11-02T12:00:00.000Z",
    "sessao": {
      "id": "sim-painel-esta",
      "titulo": "Kanban de sessões no artefato",
      "modelo": "claude-opus-5-5",
      "iniciadaEm": "2026-11-02T11:48:00.000Z",
      "status": "active",
      "estado": "active",
      "motivo": null,
      "urgente": false,
      "desde": "2026-11-02T11:59:57.000Z",
      "turno": 18,
      "atividade": {
        "tipo": "ferramenta",
        "texto": "rodando Bash · npm test"
      },
      "faixa": null,
      "conta": {
        "id": "sim-conta-equipe/sim-org-equipe",
        "rotulo": "equipe",
        "cor": "rose",
        "fonte": "simulador"
      },
      "branch": null,
      "cwd": "/simulacao/ahrena-demo"
    },
    "contexto": {
      "usados": 62000,
      "limite": 200000,
      "pct": 31
    },
    "custo": {
      "usd": 1.8309456,
      "serie": [
        0,
        0.1062826,
        0.21372760000000002,
        0.32233520000000004,
        0.4321052000000001,
        0.5430378000000001,
        0.6551328000000001,
        0.7683904,
        0.8828104,
        0.998393,
        1.115138,
        1.2330456,
        1.3521156,
        1.4723482,
        1.5937432,
        1.7163008,
        1.8309456
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 897128,
      "saida": 78016
    },
    "background": {
      "total": 2,
      "primeiro": "npm run dev"
    },
    "plano": {
      "feitos": 3,
      "total": 6,
      "atual": "Rodar a bateria",
      "proximo": "Abrir o PR",
      "restantes": 1
    },
    "subagentes": {
      "ativos": 1,
      "itens": [
        {
          "id": "sim-painel-esta:a0",
          "nome": "Explore",
          "tarefa": "mapear usos",
          "status": "working",
          "desde": "2026-11-02T11:59:18.000Z",
          "ate": null
        },
        {
          "id": "sim-painel-esta:a1",
          "nome": "Plan",
          "tarefa": "plano",
          "status": "completed",
          "desde": "2026-11-02T11:49:00.000Z",
          "ate": "2026-11-02T11:51:00.000Z"
        }
      ]
    },
    "filhas": [],
    "trabalho": {
      "branch": "feat/42-kanban-de-sessoes",
      "repo": "exemplo/simulacao",
      "issue": {
        "numero": 42,
        "titulo": "Kanban de sessões",
        "url": "https://github.com/exemplo/simulacao/issues/42",
        "subIssues": {
          "feitas": 2,
          "total": 4
        }
      },
      "pr": {
        "numero": 78,
        "url": "https://github.com/exemplo/simulacao/pull/78",
        "estado": "rascunho",
        "ci": "ok",
        "review": "pendente"
      },
      "semPush": false,
      "erro": null
    },
    "precisam": {
      "total": 2,
      "porConta": [
        {
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          },
          "n": 1
        },
        {
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          },
          "n": 1
        }
      ],
      "familia": [],
      "maquina": [
        {
          "id": "sim-painel-motor-de-regras",
          "titulo": "motor-de-regras",
          "estado": "waiting",
          "motivo": "notification",
          "urgente": true,
          "desde": "2026-11-02T11:58:00.000Z",
          "texto": "Bash: npm run migrate",
          "modelo": "claude-opus-5-5",
          "relacao": null,
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          }
        },
        {
          "id": "sim-painel-app-receitas",
          "titulo": "app-receitas",
          "estado": "waiting",
          "motivo": "interrupted",
          "urgente": true,
          "desde": "2026-11-02T11:54:00.000Z",
          "texto": "Esc no meio do turno",
          "modelo": "claude-sonnet-5-5",
          "relacao": null,
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          }
        }
      ]
    }
  },
  "p2": {
    "versao": 1,
    "geradoEm": "2026-11-02T12:00:00.000Z",
    "sessao": {
      "id": "sim-painel-esta",
      "titulo": "Testes de integração da API",
      "modelo": "claude-opus-5-5",
      "iniciadaEm": "2026-11-02T11:34:00.000Z",
      "status": "waiting",
      "estado": "waiting",
      "motivo": "notification",
      "urgente": true,
      "desde": "2026-11-02T11:56:00.000Z",
      "turno": 11,
      "atividade": {
        "tipo": "pergunta",
        "texto": "pergunta pendente"
      },
      "faixa": {
        "tipo": "pergunta",
        "texto": "Nos testes de integração, sigo com SQLite em memória ou subo um Postgres no Docker?",
        "rodape": "3 opções · responda na conversa ao lado",
        "desde": "2026-11-02T11:56:00.000Z"
      },
      "conta": {
        "id": "sim-conta-equipe/sim-org-equipe",
        "rotulo": "equipe",
        "cor": "rose",
        "fonte": "simulador"
      },
      "branch": null,
      "cwd": "/simulacao/gateway-sandbox"
    },
    "contexto": {
      "usados": 96000,
      "limite": 200000,
      "pct": 48
    },
    "custo": {
      "usd": 0.908154,
      "serie": [
        0,
        0.044,
        0.08979999999999999,
        0.1374,
        0.1868,
        0.238,
        0.291,
        0.3458,
        0.4024,
        0.4608,
        0.521,
        0.583,
        0.6467999999999999,
        0.7123999999999999,
        0.7797999999999999,
        0.849,
        0.908154
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 1316770,
      "saida": 27680
    },
    "background": {
      "total": 1,
      "primeiro": "npm run dev"
    },
    "plano": {
      "feitos": 1,
      "total": 4,
      "atual": "Decidir o banco",
      "proximo": "Escrever os casos de borda",
      "restantes": 1
    },
    "subagentes": {
      "ativos": 0,
      "itens": [
        {
          "id": "sim-painel-esta:a0",
          "nome": "Explore",
          "tarefa": "ler testes",
          "status": "completed",
          "desde": "2026-11-02T11:44:00.000Z",
          "ate": "2026-11-02T11:45:00.000Z"
        }
      ]
    },
    "filhas": [],
    "trabalho": {
      "branch": "feat/51-testes-de-integracao",
      "repo": "exemplo/simulacao",
      "issue": {
        "numero": 51,
        "titulo": "Testes de integração",
        "url": "https://github.com/exemplo/simulacao/issues/51",
        "subIssues": {
          "feitas": 0,
          "total": 3
        }
      },
      "pr": null,
      "semPush": true,
      "erro": null
    },
    "precisam": {
      "total": 0,
      "porConta": [],
      "familia": [],
      "maquina": []
    }
  },
  "p3": {
    "versao": 1,
    "geradoEm": "2026-11-02T12:00:00.000Z",
    "sessao": {
      "id": "sim-painel-esta",
      "titulo": "Migração do esquema de pedidos",
      "modelo": "claude-opus-5-5",
      "iniciadaEm": "2026-11-02T11:26:00.000Z",
      "status": "waiting",
      "estado": "waiting",
      "motivo": "notification",
      "urgente": true,
      "desde": "2026-11-02T11:58:00.000Z",
      "turno": 22,
      "atividade": {
        "tipo": "permissao",
        "texto": "Bash: npm run migrate"
      },
      "faixa": {
        "tipo": "permissao",
        "texto": "Bash quer rodar npm run migrate em /simulacao/motor-de-regras",
        "rodape": "permitir ou negar na conversa ao lado",
        "desde": "2026-11-02T11:58:00.000Z"
      },
      "conta": {
        "id": "sim-conta-equipe/sim-org-equipe",
        "rotulo": "equipe",
        "cor": "rose",
        "fonte": "simulador"
      },
      "branch": null,
      "cwd": "/simulacao/motor-de-regras"
    },
    "contexto": {
      "usados": 108000,
      "limite": 200000,
      "pct": 54
    },
    "custo": {
      "usd": 2.0862756,
      "serie": [
        0,
        0.116065,
        0.234155,
        0.35427,
        0.47641,
        0.600575,
        0.726765,
        0.85498,
        0.98522,
        1.117485,
        1.251775,
        1.38809,
        1.52643,
        1.666795,
        1.809185,
        1.9536,
        2.0862756
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 1460178,
      "saida": 85152
    },
    "background": {
      "total": 0,
      "primeiro": null
    },
    "plano": {
      "feitos": 4,
      "total": 6,
      "atual": "Aplicar a migração",
      "proximo": "Atualizar o seed",
      "restantes": 0
    },
    "subagentes": {
      "ativos": 0,
      "itens": [
        {
          "id": "sim-painel-esta:a0",
          "nome": "Explore",
          "tarefa": "esquema atual",
          "status": "completed",
          "desde": "2026-11-02T11:33:00.000Z",
          "ate": "2026-11-02T11:40:00.000Z"
        }
      ]
    },
    "filhas": [],
    "trabalho": {
      "branch": "feat/58-esquema-de-pedidos",
      "repo": "exemplo/simulacao",
      "issue": {
        "numero": 58,
        "titulo": "Esquema de pedidos",
        "url": "https://github.com/exemplo/simulacao/issues/58",
        "subIssues": {
          "feitas": 3,
          "total": 5
        }
      },
      "pr": {
        "numero": 91,
        "url": "https://github.com/exemplo/simulacao/pull/91",
        "estado": "aberto",
        "ci": "ok",
        "review": "pendente"
      },
      "semPush": false,
      "erro": null
    },
    "precisam": {
      "total": 1,
      "porConta": [
        {
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          },
          "n": 1
        }
      ],
      "familia": [
        {
          "id": "sim-painel-app-receitas",
          "titulo": "app-receitas",
          "estado": "waiting",
          "motivo": "interrupted",
          "urgente": true,
          "desde": "2026-11-02T11:54:00.000Z",
          "texto": "Esc no meio do turno",
          "modelo": "claude-sonnet-5-5",
          "relacao": "mae",
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          }
        }
      ],
      "maquina": [
        {
          "id": "sim-painel-app-receitas",
          "titulo": "app-receitas",
          "estado": "waiting",
          "motivo": "interrupted",
          "urgente": true,
          "desde": "2026-11-02T11:54:00.000Z",
          "texto": "Esc no meio do turno",
          "modelo": "claude-sonnet-5-5",
          "relacao": "mae",
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          }
        }
      ]
    }
  },
  "p4": {
    "versao": 1,
    "geradoEm": "2026-11-02T12:00:00.000Z",
    "sessao": {
      "id": "sim-painel-esta",
      "titulo": "Separar pagamentos em serviços",
      "modelo": "claude-opus-5-5",
      "iniciadaEm": "2026-11-02T11:32:00.000Z",
      "status": "active",
      "estado": "delegating",
      "motivo": null,
      "urgente": false,
      "desde": "2026-11-02T11:59:57.000Z",
      "turno": 9,
      "atividade": {
        "tipo": "delegando",
        "texto": "esperando 3 subagentes"
      },
      "faixa": null,
      "conta": {
        "id": "sim-conta-equipe/sim-org-equipe",
        "rotulo": "equipe",
        "cor": "rose",
        "fonte": "simulador"
      },
      "branch": null,
      "cwd": "/simulacao/vitrine-demo"
    },
    "contexto": {
      "usados": 114000,
      "limite": 200000,
      "pct": 57
    },
    "custo": {
      "usd": 3.4546897999999997,
      "serie": [
        0,
        0.2008376,
        0.40381259999999997,
        0.6089251999999999,
        0.8161752,
        1.0255627999999999,
        1.2370877999999998,
        1.4507503999999998,
        1.6665503999999998,
        1.8844879999999997,
        2.1045629999999997,
        2.3267756,
        2.5511255999999998,
        2.7776132,
        3.0062382,
        3.2370007999999997,
        3.4546897999999997
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 1529449,
      "saida": 152880
    },
    "background": {
      "total": 0,
      "primeiro": null
    },
    "plano": {
      "feitos": 2,
      "total": 6,
      "atual": "Extrair a cobrança",
      "proximo": "Migrar os testes",
      "restantes": 2
    },
    "subagentes": {
      "ativos": 3,
      "itens": [
        {
          "id": "sim-painel-esta:a2",
          "nome": "test-runner",
          "tarefa": "bateria",
          "status": "working",
          "desde": "2026-11-02T11:59:48.000Z",
          "ate": null
        },
        {
          "id": "sim-painel-esta:a1",
          "nome": "code-reviewer",
          "tarefa": "diff",
          "status": "working",
          "desde": "2026-11-02T11:59:18.000Z",
          "ate": null
        },
        {
          "id": "sim-painel-esta:a0",
          "nome": "Explore",
          "tarefa": "achar usos",
          "status": "working",
          "desde": "2026-11-02T11:59:00.000Z",
          "ate": null
        },
        {
          "id": "sim-painel-esta:a3",
          "nome": "Plan",
          "tarefa": "plano",
          "status": "completed",
          "desde": "2026-11-02T11:37:00.000Z",
          "ate": "2026-11-02T11:40:00.000Z"
        }
      ]
    },
    "filhas": [
      {
        "id": "sim-painel-fila-de-tarefas",
        "titulo": "fila-de-tarefas",
        "estado": "waiting",
        "motivo": "stop",
        "desde": "2026-11-02T11:59:00.000Z"
      },
      {
        "id": "sim-painel-catalogo-exemplo",
        "titulo": "catalogo-exemplo",
        "estado": "active",
        "motivo": null,
        "desde": "2026-11-02T11:54:00.000Z"
      },
      {
        "id": "sim-painel-blog-estatico",
        "titulo": "blog-estatico",
        "estado": "completed",
        "motivo": null,
        "desde": "2026-11-02T11:40:00.000Z"
      }
    ],
    "trabalho": {
      "branch": "feat/63-separar-pagamentos",
      "repo": "exemplo/simulacao",
      "issue": {
        "numero": 63,
        "titulo": "Separar pagamentos",
        "url": "https://github.com/exemplo/simulacao/issues/63",
        "subIssues": {
          "feitas": 2,
          "total": 6
        }
      },
      "pr": {
        "numero": 90,
        "url": "https://github.com/exemplo/simulacao/pull/90",
        "estado": "aberto",
        "ci": "rodando",
        "review": "aprovado"
      },
      "semPush": false,
      "erro": null
    },
    "precisam": {
      "total": 1,
      "porConta": [
        {
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          },
          "n": 1
        }
      ],
      "familia": [
        {
          "id": "sim-painel-fila-de-tarefas",
          "titulo": "fila-de-tarefas",
          "estado": "waiting",
          "motivo": "stop",
          "urgente": false,
          "desde": "2026-11-02T11:59:00.000Z",
          "texto": "\"Terminei a migração. Rodo os testes?\"",
          "modelo": "claude-sonnet-5-5",
          "relacao": "filha",
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          }
        }
      ],
      "maquina": [
        {
          "id": "sim-painel-fila-de-tarefas",
          "titulo": "fila-de-tarefas",
          "estado": "waiting",
          "motivo": "stop",
          "urgente": false,
          "desde": "2026-11-02T11:59:00.000Z",
          "texto": "\"Terminei a migração. Rodo os testes?\"",
          "modelo": "claude-sonnet-5-5",
          "relacao": "filha",
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          }
        }
      ]
    }
  },
  "p5": {
    "versao": 1,
    "geradoEm": "2026-11-02T12:00:00.000Z",
    "sessao": {
      "id": "sim-painel-esta",
      "titulo": "Relatório mensal mais rápido",
      "modelo": "claude-opus-5-5",
      "iniciadaEm": "2026-11-02T11:02:00.000Z",
      "status": "error",
      "estado": "error",
      "motivo": null,
      "urgente": false,
      "desde": "2026-11-02T11:57:00.000Z",
      "turno": 23,
      "atividade": {
        "tipo": "erro",
        "texto": "API 529 · overloaded_error. Parou depois de 3 tentativas, em Edit src/relatorio/consulta.ts"
      },
      "faixa": {
        "tipo": "erro",
        "texto": "API 529 · overloaded_error. Parou depois de 3 tentativas, em Edit src/relatorio/consulta.ts",
        "rodape": "mande uma mensagem na conversa para retomar",
        "desde": "2026-11-02T11:57:00.000Z"
      },
      "conta": {
        "id": "sim-conta-equipe/sim-org-equipe",
        "rotulo": "equipe",
        "cor": "rose",
        "fonte": "simulador"
      },
      "branch": null,
      "cwd": "/simulacao/painel-de-metricas"
    },
    "contexto": {
      "usados": 168000,
      "limite": 200000,
      "pct": 84
    },
    "custo": {
      "usd": 4.0791612,
      "serie": [
        0,
        0.23263,
        0.46841,
        0.70734,
        0.9494199999999999,
        1.19465,
        1.44303,
        1.69456,
        1.94924,
        2.20707,
        2.46805,
        2.7321799999999996,
        2.9994599999999996,
        3.2698899999999997,
        3.5434699999999997,
        3.8202,
        4.0791612
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 2189406,
      "saida": 177504
    },
    "background": {
      "total": 1,
      "primeiro": "npm test -- --watch"
    },
    "plano": {
      "feitos": 3,
      "total": 4,
      "atual": "Reescrever a consulta",
      "proximo": null,
      "restantes": 0
    },
    "subagentes": {
      "ativos": 0,
      "itens": [
        {
          "id": "sim-painel-esta:a0",
          "nome": "test-runner",
          "tarefa": "bateria",
          "status": "error",
          "desde": "2026-11-02T11:53:00.000Z",
          "ate": "2026-11-02T11:55:00.000Z"
        },
        {
          "id": "sim-painel-esta:a1",
          "nome": "Explore",
          "tarefa": "índices",
          "status": "completed",
          "desde": "2026-11-02T11:29:00.000Z",
          "ate": "2026-11-02T11:30:00.000Z"
        }
      ]
    },
    "filhas": [],
    "trabalho": {
      "branch": "feat/47-acelerar-o-relatorio",
      "repo": "exemplo/simulacao",
      "issue": {
        "numero": 47,
        "titulo": "Acelerar o relatório",
        "url": "https://github.com/exemplo/simulacao/issues/47",
        "subIssues": {
          "feitas": 3,
          "total": 4
        }
      },
      "pr": {
        "numero": 88,
        "url": "https://github.com/exemplo/simulacao/pull/88",
        "estado": "aberto",
        "ci": "falhou",
        "review": "ajustes"
      },
      "semPush": false,
      "erro": null
    },
    "precisam": {
      "total": 2,
      "porConta": [
        {
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          },
          "n": 1
        },
        {
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          },
          "n": 1
        }
      ],
      "familia": [],
      "maquina": [
        {
          "id": "sim-painel-motor-de-regras",
          "titulo": "motor-de-regras",
          "estado": "waiting",
          "motivo": "notification",
          "urgente": true,
          "desde": "2026-11-02T11:58:00.000Z",
          "texto": "Bash: npm run migrate",
          "modelo": "claude-opus-5-5",
          "relacao": null,
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          }
        },
        {
          "id": "sim-painel-app-receitas",
          "titulo": "app-receitas",
          "estado": "waiting",
          "motivo": "interrupted",
          "urgente": true,
          "desde": "2026-11-02T11:54:00.000Z",
          "texto": "Esc no meio do turno",
          "modelo": "claude-sonnet-5-5",
          "relacao": null,
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          }
        }
      ]
    }
  },
  "p6": {
    "versao": 1,
    "geradoEm": "2026-11-02T12:00:00.000Z",
    "sessao": {
      "id": "sim-painel-esta",
      "titulo": "Sessão nova, sem transcript",
      "modelo": "claude-sonnet-5-5",
      "iniciadaEm": "2026-11-02T12:00:00.000Z",
      "status": "waiting",
      "estado": "waiting",
      "motivo": "session_start",
      "urgente": false,
      "desde": "2026-11-02T12:00:00.000Z",
      "turno": 0,
      "atividade": {
        "tipo": "prompt",
        "texto": "esperando o primeiro prompt"
      },
      "faixa": null,
      "conta": null,
      "branch": null,
      "cwd": "/simulacao/cli-de-notas"
    },
    "contexto": null,
    "custo": null,
    "tokens": null,
    "background": {
      "total": 0,
      "primeiro": null
    },
    "plano": null,
    "subagentes": {
      "ativos": 0,
      "itens": []
    },
    "filhas": [],
    "trabalho": {
      "branch": "main",
      "repo": "exemplo/simulacao",
      "issue": null,
      "pr": null,
      "semPush": false,
      "erro": null
    },
    "precisam": {
      "total": 3,
      "porConta": [
        {
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          },
          "n": 2
        },
        {
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          },
          "n": 1
        }
      ],
      "familia": [],
      "maquina": [
        {
          "id": "sim-painel-motor-de-regras",
          "titulo": "motor-de-regras",
          "estado": "waiting",
          "motivo": "notification",
          "urgente": true,
          "desde": "2026-11-02T11:58:00.000Z",
          "texto": "Bash: npm run migrate",
          "modelo": "claude-opus-5-5",
          "relacao": null,
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          }
        },
        {
          "id": "sim-painel-painel-de-metricas",
          "titulo": "painel-de-metricas",
          "estado": "error",
          "motivo": null,
          "urgente": true,
          "desde": "2026-11-02T11:57:00.000Z",
          "texto": "API 529 · overloaded_error",
          "modelo": "claude-opus-5-5",
          "relacao": null,
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          }
        },
        {
          "id": "sim-painel-app-receitas",
          "titulo": "app-receitas",
          "estado": "waiting",
          "motivo": "interrupted",
          "urgente": true,
          "desde": "2026-11-02T11:54:00.000Z",
          "texto": "Esc no meio do turno",
          "modelo": "claude-sonnet-5-5",
          "relacao": null,
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          }
        }
      ]
    }
  },
  "p7": {
    "versao": 1,
    "geradoEm": "2026-11-02T12:00:00.000Z",
    "sessao": {
      "id": "sim-painel-esta",
      "titulo": "Kanban de sessões no artefato",
      "modelo": "claude-opus-5-5",
      "iniciadaEm": "2026-11-02T11:48:00.000Z",
      "status": "active",
      "estado": "active",
      "motivo": null,
      "urgente": false,
      "desde": "2026-11-02T11:59:57.000Z",
      "turno": 18,
      "atividade": {
        "tipo": "ferramenta",
        "texto": "rodando Bash · npm test"
      },
      "faixa": null,
      "conta": {
        "id": "sim-conta-equipe/sim-org-equipe",
        "rotulo": "equipe",
        "cor": "rose",
        "fonte": "simulador"
      },
      "branch": null,
      "cwd": "/simulacao/ahrena-demo"
    },
    "contexto": {
      "usados": 62000,
      "limite": 200000,
      "pct": 31
    },
    "custo": {
      "usd": 1.8309456,
      "serie": [
        0,
        0.1062826,
        0.21372760000000002,
        0.32233520000000004,
        0.4321052000000001,
        0.5430378000000001,
        0.6551328000000001,
        0.7683904,
        0.8828104,
        0.998393,
        1.115138,
        1.2330456,
        1.3521156,
        1.4723482,
        1.5937432,
        1.7163008,
        1.8309456
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 897128,
      "saida": 78016
    },
    "background": {
      "total": 2,
      "primeiro": "npm run dev"
    },
    "plano": null,
    "subagentes": {
      "ativos": 0,
      "itens": []
    },
    "filhas": [
      {
        "id": "sim-painel-fila-de-tarefas",
        "titulo": "fila-de-tarefas",
        "estado": "waiting",
        "motivo": "stop",
        "desde": "2026-11-02T11:59:00.000Z"
      }
    ],
    "trabalho": {
      "branch": "feat/42-kanban-de-sessoes",
      "repo": "exemplo/simulacao",
      "issue": {
        "numero": 42,
        "titulo": "Kanban de sessões",
        "url": "https://github.com/exemplo/simulacao/issues/42",
        "subIssues": {
          "feitas": 2,
          "total": 4
        }
      },
      "pr": {
        "numero": 78,
        "url": "https://github.com/exemplo/simulacao/pull/78",
        "estado": "rascunho",
        "ci": "ok",
        "review": "pendente"
      },
      "semPush": false,
      "erro": null
    },
    "precisam": {
      "total": 3,
      "porConta": [
        {
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          },
          "n": 2
        },
        {
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          },
          "n": 1
        }
      ],
      "familia": [
        {
          "id": "sim-painel-motor-de-regras",
          "titulo": "motor-de-regras",
          "estado": "waiting",
          "motivo": "notification",
          "urgente": true,
          "desde": "2026-11-02T11:58:00.000Z",
          "texto": "Bash: npm run migrate",
          "modelo": "claude-opus-5-5",
          "relacao": "mae",
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          }
        },
        {
          "id": "sim-painel-fila-de-tarefas",
          "titulo": "fila-de-tarefas",
          "estado": "waiting",
          "motivo": "stop",
          "urgente": false,
          "desde": "2026-11-02T11:59:00.000Z",
          "texto": "\"Terminei a migração. Rodo os testes?\"",
          "modelo": "claude-sonnet-5-5",
          "relacao": "filha",
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          }
        }
      ],
      "maquina": [
        {
          "id": "sim-painel-motor-de-regras",
          "titulo": "motor-de-regras",
          "estado": "waiting",
          "motivo": "notification",
          "urgente": true,
          "desde": "2026-11-02T11:58:00.000Z",
          "texto": "Bash: npm run migrate",
          "modelo": "claude-opus-5-5",
          "relacao": "mae",
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          }
        },
        {
          "id": "sim-painel-painel-de-metricas",
          "titulo": "painel-de-metricas",
          "estado": "error",
          "motivo": null,
          "urgente": true,
          "desde": "2026-11-02T11:57:00.000Z",
          "texto": "API 529 · overloaded_error",
          "modelo": "claude-opus-5-5",
          "relacao": null,
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-cliente/sim-org-cliente",
            "rotulo": "cliente-exemplo",
            "cor": "green",
            "fonte": "simulador"
          }
        },
        {
          "id": "sim-painel-fila-de-tarefas",
          "titulo": "fila-de-tarefas",
          "estado": "waiting",
          "motivo": "stop",
          "urgente": false,
          "desde": "2026-11-02T11:59:00.000Z",
          "texto": "\"Terminei a migração. Rodo os testes?\"",
          "modelo": "claude-sonnet-5-5",
          "relacao": "filha",
          "mesmoProjeto": false,
          "conta": {
            "id": "sim-conta-equipe/sim-org-equipe",
            "rotulo": "equipe",
            "cor": "rose",
            "fonte": "simulador"
          }
        }
      ]
    }
  }
}
