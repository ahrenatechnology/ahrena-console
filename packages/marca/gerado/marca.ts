// Gerado por packages/marca/src/gerar.ts a partir de docs/brand/tokens.json. Não edite: mude o tokens.json e rode `node packages/marca/src/gerar.ts`.

export const paleta = {
  "orange": {
    "100": "#fde3d1",
    "200": "#fac29b",
    "500": "#f47720",
    "700": "#ab5316",
    "900": "#612f0d"
  },
  "rose": {
    "500": "#df285d",
    "700": "#b81f4b"
  },
  "yellow": {
    "100": "#fff3ce",
    "200": "#ffe490",
    "500": "#ffc30a",
    "700": "#b28807",
    "900": "#664e04"
  },
  "green": {
    "500": "#1baf7a",
    "700": "#0d7350"
  },
  "red": {
    "300": "#f06463",
    "500": "#e34948",
    "700": "#b42a2a"
  },
  "gray": {
    "100": "#d7d7d9",
    "200": "#a6a6aa",
    "300": "#5a5a63",
    "500": "#3a3a44",
    "700": "#28282f",
    "800": "#1e1e24",
    "900": "#17171b"
  },
  "mono": {
    "white": "#fdfdfd",
    "black": "#0e1016"
  }
} as const

export const ci = {
  "success": "#1baf7a",
  "failure": "#e34948",
  "pending": "#ffc30a"
} as const

export const temas = {
  "dark": {
    "bg": "#17171b",
    "surface": "#1e1e24",
    "raised": "#28282f",
    "border": "#3a3a44",
    "text": "#d7d7d9",
    "muted": "#a6a6aa",
    "accent": "#f47720",
    "onAccent": "#17171b",
    "accentText": "#f47720",
    "rose": "#df285d"
  },
  "light": {
    "bg": "#f4f4f5",
    "surface": "#fdfdfd",
    "raised": "#efeff1",
    "border": "#d7d7d9",
    "text": "#17171b",
    "muted": "#5a5a63",
    "accent": "#f47720",
    "onAccent": "#17171b",
    "accentText": "#ab5316",
    "rose": "#df285d"
  }
} as const

export const ordemStatus = [
  "active",
  "waiting",
  "completed",
  "error",
  "abandoned"
] as const

export const status = {
  "active": {
    "label": "Ativa",
    "glyph": "●",
    "color": "#f47720",
    "dark": {
      "dot": "#f47720",
      "text": "#f47720",
      "badge": "#382924"
    },
    "light": {
      "dot": "#ab5316",
      "text": "#ab5316",
      "badge": "#fcede2"
    }
  },
  "waiting": {
    "label": "Esperando você",
    "glyph": "◐",
    "color": "#ffc30a",
    "motivos": {
      "notification": {
        "label": "Pede permissão",
        "urgente": true
      },
      "interrupted": {
        "label": "Interrompida",
        "urgente": true
      },
      "stop": {
        "label": "Sua vez",
        "urgente": false
      },
      "session_start": {
        "label": "No prompt",
        "urgente": false
      }
    },
    "dark": {
      "dot": "#ffc30a",
      "text": "#ffc30a",
      "badge": "#393221"
    },
    "light": {
      "dot": "#664e04",
      "text": "#664e04",
      "badge": "#fdf6e0"
    }
  },
  "completed": {
    "label": "Concluída",
    "glyph": "✓",
    "color": "#1baf7a",
    "dark": {
      "dot": "#1baf7a",
      "text": "#1baf7a",
      "badge": "#1e2f2e"
    },
    "light": {
      "dot": "#0d7350",
      "text": "#0d7350",
      "badge": "#e2f4ed"
    }
  },
  "error": {
    "label": "Com erro",
    "glyph": "✕",
    "color": "#e34948",
    "dark": {
      "dot": "#e34948",
      "text": "#f06463",
      "badge": "#362328"
    },
    "light": {
      "dot": "#b42a2a",
      "text": "#b42a2a",
      "badge": "#fae7e7"
    }
  },
  "abandoned": {
    "label": "Abandonada",
    "glyph": "○",
    "color": "#a6a6aa",
    "dark": {
      "dot": "#a6a6aa",
      "text": "#a6a6aa",
      "badge": "#2e2e34"
    },
    "light": {
      "dot": "#5a5a63",
      "text": "#5a5a63",
      "badge": "#f3f3f3"
    }
  }
} as const

export const tipografia = {
  "sans": "\"Poppins\", \"Roboto\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", sans-serif",
  "mono": "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, monospace",
  "googleFonts": "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap",
  "size": {
    "xs": "12px",
    "sm": "13px",
    "md": "14px",
    "lg": "16px",
    "xl": "20px",
    "xxl": "28px"
  },
  "weight": {
    "regular": 400,
    "medium": 500,
    "semibold": 600
  },
  "usos": {
    "sans": "títulos, rótulos e texto corrido no artefato",
    "mono": "ids, caminhos, números de tabela, custo e tokens; e tudo no painel nativo"
  }
} as const

export type Tema = keyof typeof temas
export type StatusId = (typeof ordemStatus)[number]
