// Client do painel: uma linha de pulso animada que mostra há quanto tempo veio a
// última leitura do núcleo. Roda com o próprio timer, sem redesenhar o painel todo.
import type { ClientSurface } from 'claude-code'

type Props = { generatedAt: string | null }
type State = { frame: number; started: boolean }

const WAVE = '▁▂▃▅▇▅▃▂▁▁▁▁'

export default function Pulso(props: Props, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const st = surface.state ?? { frame: 0, started: false }
  if (!st.started) {
    surface.every(150, () => {
      const cur = surface.state ?? { frame: 0, started: true }
      surface.setState({ frame: cur.frame + 1, started: true })
    })
    surface.setState({ frame: 0, started: true })
  }
  const width = Math.max(12, Math.min(48, surface.columns - 18))
  let line = ''
  for (let i = 0; i < width; i++) line += WAVE[(i + st.frame) % WAVE.length]
  const age = props.generatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(props.generatedAt)) / 1000)) : null
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={age !== null && age < 10 ? '#f47720' : '#a6a6aa'}>{line}</Text>
      <Text dimColor>{age === null ? 'sem leitura' : `há ${age}s`}</Text>
    </Box>
  )
}
