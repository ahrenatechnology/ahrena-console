// Gerado por packages/nucleo/test/api/gravar-cenarios.ts: a resposta de /api/painel em cada cenário
// do simulador (P1 a P7 e P9), com a hora fixa AGORA, e as listas de decisões do P9 por escopo.
// Não edite: rode o script de novo.
import type { EscopoDasDecisoes, ListaDeDecisoes, Painel } from '../types'

export const AGORA = 1793620800000

export const CENARIOS: Record<'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7' | 'p9', Painel> = {
  "p1": {
    "versao": 1,
    "api": {
      "versao": "0.0.1",
      "commit": null,
      "pasta": null,
      "abreSessao": false
    },
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
        "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
        "rotulo": "equipe",
        "cor": "#df285d",
        "fonte": "env"
      },
      "branch": null,
      "cwd": "/simulacao/ahrena-demo"
    },
    "contexto": {
      "usados": 62000,
      "limite": 200000,
      "pct": 31,
      "estouros": 0,
      "alerta": false,
      "compactacoesManuais": 0,
      "rotulo": "62k / 200k (31%)",
      "agentes": []
    },
    "custo": {
      "usd": 1.8387958000000002,
      "serie": [
        0,
        0.10937,
        0.21949,
        0.33036,
        0.44198,
        0.55435,
        0.66747,
        0.78134,
        0.8959600000000001,
        1.01133,
        1.12745,
        1.24432,
        1.3619400000000002,
        1.4803100000000002,
        1.5994300000000004,
        1.7193000000000003,
        1.8387958000000002
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 544379,
      "saida": 81936
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
      "restantes": 1,
      "atualDono": {
        "tipo": "principal",
        "nome": null,
        "agenteId": "sim-painel-esta:main"
      },
      "mudouEm": "2026-11-02T11:59:30.000Z",
      "passos": [
        {
          "id": "1",
          "texto": "Ler o artefato",
          "textoAtivo": "Ler o artefato",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "2",
          "texto": "Montar as raias",
          "textoAtivo": "Montar as raias",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "3",
          "texto": "Ligar ao núcleo",
          "textoAtivo": "Ligar ao núcleo",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "4",
          "texto": "Rodar a bateria",
          "textoAtivo": "Rodar a bateria",
          "estado": "in_progress",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "5",
          "texto": "Abrir o PR",
          "textoAtivo": "Abrir o PR",
          "estado": "pending",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "6",
          "texto": "Pedir review",
          "textoAtivo": "Pedir review",
          "estado": "pending",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        }
      ]
    },
    "planos": [
      {
        "numero": 3,
        "resultado": "atual",
        "resumo": "Ler o artefato",
        "feitos": 3,
        "total": 6,
        "atual": "Rodar a bateria",
        "inicio": "2026-11-02T11:54:30.000Z",
        "fim": null
      },
      {
        "numero": 2,
        "resultado": "abandonado",
        "resumo": "Prototipar o arrastar",
        "feitos": 1,
        "total": 4,
        "atual": null,
        "inicio": "2026-11-02T11:52:00.000Z",
        "fim": "2026-11-02T11:54:30.000Z"
      },
      {
        "numero": 1,
        "resultado": "concluido",
        "resumo": "Ler o wireframe do kanban",
        "feitos": 3,
        "total": 3,
        "atual": null,
        "inicio": "2026-11-02T11:49:00.000Z",
        "fim": "2026-11-02T11:52:00.000Z"
      }
    ],
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
      "total": 1,
      "suaVez": 1,
      "porConta": [
        {
          "conta": {
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          },
          "n": 1
        }
      ],
      "familia": [],
      "maquina": [
        {
          "id": "sim-painel-motor-de-regras",
          "nivel": "precisa",
          "porque": "permissao",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          }
        },
        {
          "id": "sim-painel-app-receitas",
          "nivel": "sua-vez",
          "porque": "interrompida",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1",
            "rotulo": "cliente-exemplo",
            "cor": "#1baf7a",
            "fonte": "config"
          }
        }
      ]
    },
    "prs": {
      "total": 0,
      "itens": []
    },
    "decisoes": {
      "vigentes": 0,
      "aConfirmar": 0,
      "retomada": null,
      "lista": null
    }
  },
  "p2": {
    "versao": 1,
    "api": {
      "versao": "0.0.1",
      "commit": null,
      "pasta": null,
      "abreSessao": false
    },
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
        "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
        "rotulo": "equipe",
        "cor": "#df285d",
        "fonte": "env"
      },
      "branch": null,
      "cwd": "/simulacao/gateway-sandbox"
    },
    "contexto": {
      "usados": 96000,
      "limite": 200000,
      "pct": 48,
      "estouros": 0,
      "alerta": false,
      "compactacoesManuais": 0,
      "rotulo": "96k / 200k (48%)",
      "agentes": []
    },
    "custo": {
      "usd": 0.9196068000000002,
      "serie": [
        0,
        0.048695,
        0.098565,
        0.14961,
        0.20183,
        0.25522500000000004,
        0.30979500000000004,
        0.36554000000000003,
        0.42246000000000006,
        0.48055500000000007,
        0.5398250000000001,
        0.6002700000000001,
        0.6618900000000001,
        0.7246850000000001,
        0.7886550000000001,
        0.8538000000000001,
        0.9196068000000002
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 836434,
      "saida": 33056
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
      "restantes": 1,
      "atualDono": {
        "tipo": "principal",
        "nome": null,
        "agenteId": "sim-painel-esta:main"
      },
      "mudouEm": "2026-11-02T11:55:48.000Z",
      "passos": [
        {
          "id": "1",
          "texto": "Ler os testes atuais",
          "textoAtivo": "Ler os testes atuais",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "2",
          "texto": "Decidir o banco",
          "textoAtivo": "Decidir o banco",
          "estado": "in_progress",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "3",
          "texto": "Escrever os casos de borda",
          "textoAtivo": "Escrever os casos de borda",
          "estado": "pending",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "4",
          "texto": "Rodar no CI",
          "textoAtivo": "Rodar no CI",
          "estado": "pending",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        }
      ]
    },
    "planos": [
      {
        "numero": 1,
        "resultado": "atual",
        "resumo": "Ler os testes atuais",
        "feitos": 1,
        "total": 4,
        "atual": "Decidir o banco",
        "inicio": "2026-11-02T11:55:48.000Z",
        "fim": null
      }
    ],
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
      "suaVez": 0,
      "porConta": [],
      "familia": [],
      "maquina": []
    },
    "prs": {
      "total": 0,
      "itens": []
    },
    "decisoes": {
      "vigentes": 0,
      "aConfirmar": 0,
      "retomada": null,
      "lista": null
    }
  },
  "p3": {
    "versao": 1,
    "api": {
      "versao": "0.0.1",
      "commit": null,
      "pasta": null,
      "abreSessao": false
    },
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
        "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
        "rotulo": "equipe",
        "cor": "#df285d",
        "fonte": "env"
      },
      "branch": null,
      "cwd": "/simulacao/motor-de-regras"
    },
    "contexto": {
      "usados": 108000,
      "limite": 200000,
      "pct": 54,
      "estouros": 0,
      "alerta": false,
      "compactacoesManuais": 0,
      "rotulo": "108k / 200k (54%)",
      "agentes": []
    },
    "custo": {
      "usd": 2.0986422,
      "serie": [
        0,
        0.121305,
        0.243935,
        0.36789,
        0.49317,
        0.619775,
        0.747705,
        0.87696,
        1.0075399999999999,
        1.1394449999999998,
        1.2726749999999998,
        1.4072299999999998,
        1.5431099999999998,
        1.6803149999999998,
        1.8188449999999998,
        1.9586999999999999,
        2.0986422
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 934811,
      "saida": 91024
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
      "restantes": 0,
      "atualDono": {
        "tipo": "principal",
        "nome": null,
        "agenteId": "sim-painel-esta:main"
      },
      "mudouEm": "2026-11-02T11:57:48.000Z",
      "passos": [
        {
          "id": "1",
          "texto": "Mapear as tabelas",
          "textoAtivo": "Mapear as tabelas",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "2",
          "texto": "Escrever a migração",
          "textoAtivo": "Escrever a migração",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "3",
          "texto": "Testar a volta",
          "textoAtivo": "Testar a volta",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "4",
          "texto": "Revisar índices",
          "textoAtivo": "Revisar índices",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "5",
          "texto": "Aplicar a migração",
          "textoAtivo": "Aplicar a migração",
          "estado": "in_progress",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "6",
          "texto": "Atualizar o seed",
          "textoAtivo": "Atualizar o seed",
          "estado": "pending",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        }
      ]
    },
    "planos": [
      {
        "numero": 1,
        "resultado": "atual",
        "resumo": "Mapear as tabelas",
        "feitos": 4,
        "total": 6,
        "atual": "Aplicar a migração",
        "inicio": "2026-11-02T11:57:48.000Z",
        "fim": null
      }
    ],
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
      "total": 0,
      "suaVez": 1,
      "porConta": [],
      "familia": [
        {
          "id": "sim-painel-app-receitas",
          "nivel": "sua-vez",
          "porque": "interrompida",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1",
            "rotulo": "cliente-exemplo",
            "cor": "#1baf7a",
            "fonte": "config"
          }
        }
      ],
      "maquina": [
        {
          "id": "sim-painel-app-receitas",
          "nivel": "sua-vez",
          "porque": "interrompida",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1",
            "rotulo": "cliente-exemplo",
            "cor": "#1baf7a",
            "fonte": "config"
          }
        }
      ]
    },
    "prs": {
      "total": 1,
      "itens": [
        {
          "numero": 91,
          "url": "https://github.com/exemplo/simulacao/pull/91",
          "repo": "exemplo/simulacao",
          "titulo": "#58 Esquema de pedidos",
          "sessao": {
            "id": "sim-painel-esta",
            "titulo": "Migração do esquema de pedidos",
            "local": null
          }
        }
      ]
    },
    "decisoes": {
      "vigentes": 0,
      "aConfirmar": 0,
      "retomada": null,
      "lista": null
    }
  },
  "p4": {
    "versao": 1,
    "api": {
      "versao": "0.0.1",
      "commit": null,
      "pasta": null,
      "abreSessao": false
    },
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
        "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
        "rotulo": "equipe",
        "cor": "#df285d",
        "fonte": "env"
      },
      "branch": null,
      "cwd": "/simulacao/vitrine-demo"
    },
    "contexto": {
      "usados": 114000,
      "limite": 200000,
      "pct": 57,
      "estouros": 0,
      "alerta": false,
      "compactacoesManuais": 0,
      "rotulo": "114k / 200k (57%)",
      "agentes": []
    },
    "custo": {
      "usd": 3.4679922000000003,
      "serie": [
        0,
        0.20638,
        0.41416,
        0.62334,
        0.83392,
        1.0459,
        1.25928,
        1.47406,
        1.69024,
        1.90782,
        2.1268000000000002,
        2.3471800000000003,
        2.56896,
        2.7921400000000003,
        3.0167200000000003,
        3.2427,
        3.4679922000000003
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 981561,
      "saida": 159024
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
      "restantes": 2,
      "atualDono": {
        "tipo": "principal",
        "nome": null,
        "agenteId": "sim-painel-esta:main"
      },
      "mudouEm": "2026-11-02T11:59:30.000Z",
      "passos": [
        {
          "id": "1",
          "texto": "Mapear o módulo",
          "textoAtivo": "Mapear o módulo",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "2",
          "texto": "Desenhar os serviços",
          "textoAtivo": "Desenhar os serviços",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "3",
          "texto": "Extrair a cobrança",
          "textoAtivo": "Extrair a cobrança",
          "estado": "in_progress",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "4",
          "texto": "Migrar os testes",
          "textoAtivo": "Migrar os testes",
          "estado": "pending",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "5",
          "texto": "Ajustar o deploy",
          "textoAtivo": "Ajustar o deploy",
          "estado": "pending",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "6",
          "texto": "Remover o código velho",
          "textoAtivo": "Remover o código velho",
          "estado": "pending",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        }
      ]
    },
    "planos": [
      {
        "numero": 4,
        "resultado": "atual",
        "resumo": "Mapear o módulo",
        "feitos": 2,
        "total": 6,
        "atual": "Extrair a cobrança",
        "inicio": "2026-11-02T11:50:30.000Z",
        "fim": null
      },
      {
        "numero": 3,
        "resultado": "concluido",
        "resumo": "Escrever a decisão de serviços",
        "feitos": 2,
        "total": 2,
        "atual": null,
        "inicio": "2026-11-02T11:45:00.000Z",
        "fim": "2026-11-02T11:50:30.000Z"
      },
      {
        "numero": 2,
        "resultado": "abandonado",
        "resumo": "Separar por camadas",
        "feitos": 1,
        "total": 3,
        "atual": null,
        "inicio": "2026-11-02T11:38:00.000Z",
        "fim": "2026-11-02T11:45:00.000Z"
      },
      {
        "numero": 1,
        "resultado": "concluido",
        "resumo": "Ler o módulo de pagamentos",
        "feitos": 2,
        "total": 2,
        "atual": null,
        "inicio": "2026-11-02T11:33:00.000Z",
        "fim": "2026-11-02T11:38:00.000Z"
      }
    ],
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
        "local": null,
        "titulo": "fila-de-tarefas",
        "estado": "waiting",
        "motivo": "stop",
        "desde": "2026-11-02T11:59:00.000Z"
      },
      {
        "id": "sim-painel-catalogo-exemplo",
        "local": null,
        "titulo": "catalogo-exemplo",
        "estado": "active",
        "motivo": null,
        "desde": "2026-11-02T11:54:00.000Z"
      },
      {
        "id": "sim-painel-blog-estatico",
        "local": null,
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
      "total": 0,
      "suaVez": 1,
      "porConta": [],
      "familia": [
        {
          "id": "sim-painel-fila-de-tarefas",
          "nivel": "sua-vez",
          "porque": "sua-vez",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          }
        }
      ],
      "maquina": [
        {
          "id": "sim-painel-fila-de-tarefas",
          "nivel": "sua-vez",
          "porque": "sua-vez",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          }
        }
      ]
    },
    "prs": {
      "total": 0,
      "itens": []
    },
    "decisoes": {
      "vigentes": 0,
      "aConfirmar": 0,
      "retomada": null,
      "lista": null
    }
  },
  "p5": {
    "versao": 1,
    "api": {
      "versao": "0.0.1",
      "commit": null,
      "pasta": null,
      "abreSessao": false
    },
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
        "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
        "rotulo": "equipe",
        "cor": "#df285d",
        "fonte": "env"
      },
      "branch": null,
      "cwd": "/simulacao/painel-de-metricas"
    },
    "contexto": {
      "usados": 168000,
      "limite": 200000,
      "pct": 84,
      "estouros": 0,
      "alerta": false,
      "compactacoesManuais": 0,
      "rotulo": "168k / 200k (84%)",
      "agentes": []
    },
    "custo": {
      "usd": 4.0976958,
      "serie": [
        0,
        0.240695,
        0.48346500000000003,
        0.72831,
        0.97523,
        1.2242250000000001,
        1.475295,
        1.72844,
        1.98366,
        2.240955,
        2.500325,
        2.7617700000000003,
        3.02529,
        3.2908850000000003,
        3.558555,
        3.8283,
        4.0976958
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 1438879,
      "saida": 185936
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
      "restantes": 0,
      "atualDono": {
        "tipo": "principal",
        "nome": null,
        "agenteId": "sim-painel-esta:main"
      },
      "mudouEm": "2026-11-02T11:59:30.000Z",
      "passos": [
        {
          "id": "1",
          "texto": "Medir a consulta",
          "textoAtivo": "Medir a consulta",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "2",
          "texto": "Criar os índices",
          "textoAtivo": "Criar os índices",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "3",
          "texto": "Cachear o total",
          "textoAtivo": "Cachear o total",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "4",
          "texto": "Reescrever a consulta",
          "textoAtivo": "Reescrever a consulta",
          "estado": "in_progress",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        }
      ]
    },
    "planos": [
      {
        "numero": 1,
        "resultado": "atual",
        "resumo": "Medir a consulta",
        "feitos": 3,
        "total": 4,
        "atual": "Reescrever a consulta",
        "inicio": "2026-11-02T11:59:30.000Z",
        "fim": null
      }
    ],
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
      "total": 1,
      "suaVez": 1,
      "porConta": [
        {
          "conta": {
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          },
          "n": 1
        }
      ],
      "familia": [],
      "maquina": [
        {
          "id": "sim-painel-motor-de-regras",
          "nivel": "precisa",
          "porque": "permissao",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          }
        },
        {
          "id": "sim-painel-app-receitas",
          "nivel": "sua-vez",
          "porque": "interrompida",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1",
            "rotulo": "cliente-exemplo",
            "cor": "#1baf7a",
            "fonte": "config"
          }
        }
      ]
    },
    "prs": {
      "total": 0,
      "itens": []
    },
    "decisoes": {
      "vigentes": 0,
      "aConfirmar": 0,
      "retomada": null,
      "lista": null
    }
  },
  "p6": {
    "versao": 1,
    "api": {
      "versao": "0.0.1",
      "commit": null,
      "pasta": null,
      "abreSessao": false
    },
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
    "planos": [],
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
      "total": 2,
      "suaVez": 1,
      "porConta": [
        {
          "conta": {
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          },
          "n": 1
        },
        {
          "conta": {
            "id": "00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1",
            "rotulo": "cliente-exemplo",
            "cor": "#1baf7a",
            "fonte": "config"
          },
          "n": 1
        }
      ],
      "familia": [],
      "maquina": [
        {
          "id": "sim-painel-motor-de-regras",
          "nivel": "precisa",
          "porque": "permissao",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          }
        },
        {
          "id": "sim-painel-painel-de-metricas",
          "nivel": "precisa",
          "porque": "erro",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1",
            "rotulo": "cliente-exemplo",
            "cor": "#1baf7a",
            "fonte": "config"
          }
        },
        {
          "id": "sim-painel-app-receitas",
          "nivel": "sua-vez",
          "porque": "interrompida",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1",
            "rotulo": "cliente-exemplo",
            "cor": "#1baf7a",
            "fonte": "config"
          }
        }
      ]
    },
    "prs": {
      "total": 0,
      "itens": []
    },
    "decisoes": {
      "vigentes": 0,
      "aConfirmar": 0,
      "retomada": null,
      "lista": null
    }
  },
  "p7": {
    "versao": 1,
    "api": {
      "versao": "0.0.1",
      "commit": null,
      "pasta": null,
      "abreSessao": false
    },
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
        "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
        "rotulo": "equipe",
        "cor": "#df285d",
        "fonte": "env"
      },
      "branch": null,
      "cwd": "/simulacao/ahrena-demo"
    },
    "contexto": {
      "usados": 62000,
      "limite": 200000,
      "pct": 31,
      "estouros": 0,
      "alerta": false,
      "compactacoesManuais": 0,
      "rotulo": "62k / 200k (31%)",
      "agentes": []
    },
    "custo": {
      "usd": 1.8387958000000002,
      "serie": [
        0,
        0.10937,
        0.21949,
        0.33036,
        0.44198,
        0.55435,
        0.66747,
        0.78134,
        0.8959600000000001,
        1.01133,
        1.12745,
        1.24432,
        1.3619400000000002,
        1.4803100000000002,
        1.5994300000000004,
        1.7193000000000003,
        1.8387958000000002
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 544379,
      "saida": 81936
    },
    "background": {
      "total": 2,
      "primeiro": "npm run dev"
    },
    "plano": null,
    "planos": [],
    "subagentes": {
      "ativos": 0,
      "itens": []
    },
    "filhas": [
      {
        "id": "sim-painel-fila-de-tarefas",
        "local": null,
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
      "total": 2,
      "suaVez": 1,
      "porConta": [
        {
          "conta": {
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          },
          "n": 1
        },
        {
          "conta": {
            "id": "00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1",
            "rotulo": "cliente-exemplo",
            "cor": "#1baf7a",
            "fonte": "config"
          },
          "n": 1
        }
      ],
      "familia": [
        {
          "id": "sim-painel-motor-de-regras",
          "nivel": "precisa",
          "porque": "permissao",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          }
        },
        {
          "id": "sim-painel-fila-de-tarefas",
          "nivel": "sua-vez",
          "porque": "sua-vez",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          }
        }
      ],
      "maquina": [
        {
          "id": "sim-painel-motor-de-regras",
          "nivel": "precisa",
          "porque": "permissao",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          }
        },
        {
          "id": "sim-painel-painel-de-metricas",
          "nivel": "precisa",
          "porque": "erro",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1",
            "rotulo": "cliente-exemplo",
            "cor": "#1baf7a",
            "fonte": "config"
          }
        },
        {
          "id": "sim-painel-fila-de-tarefas",
          "nivel": "sua-vez",
          "porque": "sua-vez",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          }
        }
      ]
    },
    "prs": {
      "total": 0,
      "itens": []
    },
    "decisoes": {
      "vigentes": 0,
      "aConfirmar": 0,
      "retomada": null,
      "lista": null
    }
  },
  "p9": {
    "versao": 1,
    "api": {
      "versao": "0.0.1",
      "commit": null,
      "pasta": null,
      "abreSessao": false
    },
    "geradoEm": "2026-11-02T12:00:00.000Z",
    "sessao": {
      "id": "sim-painel-esta",
      "titulo": "Kanban de sessões no artefato",
      "modelo": "claude-opus-5-5",
      "iniciadaEm": "2026-11-02T11:15:00.000Z",
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
        "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
        "rotulo": "equipe",
        "cor": "#df285d",
        "fonte": "env"
      },
      "branch": null,
      "cwd": "/simulacao/ahrena-demo"
    },
    "contexto": {
      "usados": 62000,
      "limite": 200000,
      "pct": 31,
      "estouros": 0,
      "alerta": false,
      "compactacoesManuais": 0,
      "rotulo": "62k / 200k (31%)",
      "agentes": []
    },
    "custo": {
      "usd": 1.8387958000000002,
      "serie": [
        0,
        0.10937,
        0.21949,
        0.33036,
        0.44198,
        0.55435,
        0.66747,
        0.78134,
        0.8959600000000001,
        1.01133,
        1.12745,
        1.24432,
        1.3619400000000002,
        1.4803100000000002,
        1.5994300000000004,
        1.7193000000000003,
        1.8387958000000002
      ],
      "estimativa": true
    },
    "tokens": {
      "entrada": 544379,
      "saida": 81936
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
      "restantes": 1,
      "atualDono": {
        "tipo": "principal",
        "nome": null,
        "agenteId": "sim-painel-esta:main"
      },
      "mudouEm": "2026-11-02T11:59:30.000Z",
      "passos": [
        {
          "id": "1",
          "texto": "Ler o artefato",
          "textoAtivo": "Ler o artefato",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "2",
          "texto": "Montar as raias",
          "textoAtivo": "Montar as raias",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "3",
          "texto": "Ligar ao núcleo",
          "textoAtivo": "Ligar ao núcleo",
          "estado": "completed",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "4",
          "texto": "Rodar a bateria",
          "textoAtivo": "Rodar a bateria",
          "estado": "in_progress",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "5",
          "texto": "Abrir o PR",
          "textoAtivo": "Abrir o PR",
          "estado": "pending",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        },
        {
          "id": "6",
          "texto": "Pedir review",
          "textoAtivo": "Pedir review",
          "estado": "pending",
          "dono": {
            "tipo": "principal",
            "nome": null,
            "agenteId": "sim-painel-esta:main"
          }
        }
      ]
    },
    "planos": [
      {
        "numero": 3,
        "resultado": "atual",
        "resumo": "Ler o artefato",
        "feitos": 3,
        "total": 6,
        "atual": "Rodar a bateria",
        "inicio": "2026-11-02T11:54:30.000Z",
        "fim": null
      },
      {
        "numero": 2,
        "resultado": "abandonado",
        "resumo": "Prototipar o arrastar",
        "feitos": 1,
        "total": 4,
        "atual": null,
        "inicio": "2026-11-02T11:52:00.000Z",
        "fim": "2026-11-02T11:54:30.000Z"
      },
      {
        "numero": 1,
        "resultado": "concluido",
        "resumo": "Ler o wireframe do kanban",
        "feitos": 3,
        "total": 3,
        "atual": null,
        "inicio": "2026-11-02T11:49:00.000Z",
        "fim": "2026-11-02T11:52:00.000Z"
      }
    ],
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
      "total": 1,
      "suaVez": 1,
      "porConta": [
        {
          "conta": {
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          },
          "n": 1
        }
      ],
      "familia": [],
      "maquina": [
        {
          "id": "sim-painel-motor-de-regras",
          "nivel": "precisa",
          "porque": "permissao",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ea1/00000000-0000-4000-8000-000000000eb1",
            "rotulo": "equipe",
            "cor": "#df285d",
            "fonte": "env"
          }
        },
        {
          "id": "sim-painel-app-receitas",
          "nivel": "sua-vez",
          "porque": "interrompida",
          "local": null,
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
            "id": "00000000-0000-4000-8000-000000000ca1/00000000-0000-4000-8000-000000000cb1",
            "rotulo": "cliente-exemplo",
            "cor": "#1baf7a",
            "fonte": "config"
          }
        }
      ]
    },
    "prs": {
      "total": 0,
      "itens": []
    },
    "decisoes": {
      "vigentes": 4,
      "aConfirmar": 1,
      "retomada": null,
      "lista": null
    }
  }
}

export const LISTAS_DO_P9: Record<EscopoDasDecisoes, ListaDeDecisoes> = {
  "sessao": {
    "escopo": "sessao",
    "vigentes": 3,
    "aConfirmar": 1,
    "itens": [
      {
        "id": "dec:4b1fc2d63bedbe4d5f12f4872295b249",
        "rotulo": "D6",
        "origem": "sugerida",
        "estado": "a_confirmar",
        "titulo": "10 cards por coluna, com \"mostrar mais\"",
        "texto": "10 cards por coluna, com \"mostrar mais\"",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "20 por coluna",
          "rolagem infinita"
        ],
        "decididaPor": "agente",
        "decididaEm": "2026-11-02T11:54:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-6"
      },
      {
        "id": "dec:721f725b29038c452e1e8d1fd8c5b308",
        "rotulo": "D4",
        "origem": "correcao",
        "estado": "vigente",
        "titulo": "SQLite em memória nos testes",
        "texto": "SQLite em memória nos testes",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "Postgres no Docker"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:46:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-4"
      },
      {
        "id": "dec:cda960a6daa8bb39fe98ffa6da7a598f",
        "rotulo": "D5",
        "origem": "permissao",
        "estado": "vigente",
        "titulo": "Permitir npm test sem perguntar",
        "texto": "Permitir npm test sem perguntar",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "perguntar a cada vez"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:39:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-5"
      },
      {
        "id": "dec:38854e93da5d477d7ed844642a6eb1a3",
        "rotulo": "D3",
        "origem": "pergunta",
        "estado": "substituida",
        "titulo": "Postgres no Docker nos testes",
        "texto": "Postgres no Docker nos testes",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "SQLite em memória"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:27:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": "D4",
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-3"
      },
      {
        "id": "dec:0d2116499443e79f4a9757d2ad01f803",
        "rotulo": "D2",
        "origem": "plano",
        "estado": "vigente",
        "titulo": "Plano de 5 passos aprovado",
        "texto": "Plano de 5 passos aprovado",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "plano com drag-and-drop"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:20:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-2"
      }
    ]
  },
  "familia": {
    "escopo": "familia",
    "vigentes": 4,
    "aConfirmar": 1,
    "itens": [
      {
        "id": "dec:4b1fc2d63bedbe4d5f12f4872295b249",
        "rotulo": "D6",
        "origem": "sugerida",
        "estado": "a_confirmar",
        "titulo": "10 cards por coluna, com \"mostrar mais\"",
        "texto": "10 cards por coluna, com \"mostrar mais\"",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "20 por coluna",
          "rolagem infinita"
        ],
        "decididaPor": "agente",
        "decididaEm": "2026-11-02T11:54:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-6"
      },
      {
        "id": "dec:721f725b29038c452e1e8d1fd8c5b308",
        "rotulo": "D4",
        "origem": "correcao",
        "estado": "vigente",
        "titulo": "SQLite em memória nos testes",
        "texto": "SQLite em memória nos testes",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "Postgres no Docker"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:46:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-4"
      },
      {
        "id": "dec:cda960a6daa8bb39fe98ffa6da7a598f",
        "rotulo": "D5",
        "origem": "permissao",
        "estado": "vigente",
        "titulo": "Permitir npm test sem perguntar",
        "texto": "Permitir npm test sem perguntar",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "perguntar a cada vez"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:39:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-5"
      },
      {
        "id": "dec:38854e93da5d477d7ed844642a6eb1a3",
        "rotulo": "D3",
        "origem": "pergunta",
        "estado": "substituida",
        "titulo": "Postgres no Docker nos testes",
        "texto": "Postgres no Docker nos testes",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "SQLite em memória"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:27:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": "D4",
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-3"
      },
      {
        "id": "dec:0d2116499443e79f4a9757d2ad01f803",
        "rotulo": "D2",
        "origem": "plano",
        "estado": "vigente",
        "titulo": "Plano de 5 passos aprovado",
        "texto": "Plano de 5 passos aprovado",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "plano com drag-and-drop"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:20:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-2"
      },
      {
        "id": "dec:0768d762322f78a8e1990a0955accbc9",
        "rotulo": "D1",
        "origem": "pergunta",
        "estado": "vigente",
        "titulo": "Kanban só leitura, sem arrastar",
        "texto": "Kanban só leitura, sem arrastar",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "arrastar muda o status"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-01T16:00:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "mae",
        "toolUseId": null
      }
    ]
  },
  "branch": {
    "escopo": "branch",
    "vigentes": 4,
    "aConfirmar": 1,
    "itens": [
      {
        "id": "dec:4b1fc2d63bedbe4d5f12f4872295b249",
        "rotulo": "D6",
        "origem": "sugerida",
        "estado": "a_confirmar",
        "titulo": "10 cards por coluna, com \"mostrar mais\"",
        "texto": "10 cards por coluna, com \"mostrar mais\"",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "20 por coluna",
          "rolagem infinita"
        ],
        "decididaPor": "agente",
        "decididaEm": "2026-11-02T11:54:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-6"
      },
      {
        "id": "dec:721f725b29038c452e1e8d1fd8c5b308",
        "rotulo": "D4",
        "origem": "correcao",
        "estado": "vigente",
        "titulo": "SQLite em memória nos testes",
        "texto": "SQLite em memória nos testes",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "Postgres no Docker"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:46:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-4"
      },
      {
        "id": "dec:cda960a6daa8bb39fe98ffa6da7a598f",
        "rotulo": "D5",
        "origem": "permissao",
        "estado": "vigente",
        "titulo": "Permitir npm test sem perguntar",
        "texto": "Permitir npm test sem perguntar",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "perguntar a cada vez"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:39:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-5"
      },
      {
        "id": "dec:38854e93da5d477d7ed844642a6eb1a3",
        "rotulo": "D3",
        "origem": "pergunta",
        "estado": "substituida",
        "titulo": "Postgres no Docker nos testes",
        "texto": "Postgres no Docker nos testes",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "SQLite em memória"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:27:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": "D4",
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-3"
      },
      {
        "id": "dec:0d2116499443e79f4a9757d2ad01f803",
        "rotulo": "D2",
        "origem": "plano",
        "estado": "vigente",
        "titulo": "Plano de 5 passos aprovado",
        "texto": "Plano de 5 passos aprovado",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "plano com drag-and-drop"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-02T11:20:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "esta",
        "toolUseId": "sim-toolu-p9-2"
      },
      {
        "id": "dec:0768d762322f78a8e1990a0955accbc9",
        "rotulo": "D1",
        "origem": "pergunta",
        "estado": "vigente",
        "titulo": "Kanban só leitura, sem arrastar",
        "texto": "Kanban só leitura, sem arrastar",
        "contexto": null,
        "desfazer": null,
        "nao": [
          "arrastar muda o status"
        ],
        "decididaPor": "usuario",
        "decididaEm": "2026-11-01T16:00:00.000Z",
        "confirmadaEm": null,
        "substituidaPor": null,
        "sessao": "mae",
        "toolUseId": null
      }
    ]
  }
}
