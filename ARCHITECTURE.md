# Arquitetura

## Visão geral

O serviço recebe operações financeiras por HTTP ou SQS e atualiza carteiras
no PostgreSQL. As duas entradas usam `WagerProcessorService`, compartilhando
as mesmas regras. O projeto separa domínio, aplicação, interface HTTP,
infraestrutura e migrations, sem adotar uma arquitetura em camadas rígidas:
o serviço de aplicação também coordena SQL parametrizado e transações.

## Decisões principais

- **Precisão monetária:** contratos recebem valores como strings, o domínio
  usa `Decimal` e o PostgreSQL usa `numeric(20,2)`. Isso evita erros de ponto
  flutuante. A moeda é validada pelo formato de três letras, não por uma lista
  completa de códigos ISO.
- **Concorrência:** `SELECT ... FOR UPDATE` bloqueia a carteira alterada.
  Operações na mesma carteira são serializadas; carteiras diferentes podem
  avançar em paralelo. Constraints do banco também protegem saldo, unicidade
  e integridade do ledger.
- **Idempotência:** a `Idempotency-Key` e o hash do conteúdo são persistidos.
  Repetir chave e conteúdo retorna o resultado existente; reutilizar a chave
  com dados diferentes gera conflito. A identidade externa do provedor também
  é única.
- **Saldo e ledger:** saldo materializado e lançamento imutável são gravados
  na mesma transação. A reconciliação detecta divergências, mas não corrige o
  saldo automaticamente.
- **Inbox e outbox:** a inbox deduplica mensagens SQS; a outbox grava eventos
  junto da operação financeira e os publica após o commit. A entrega é
  *at-least-once*: uma falha depois do envio pode gerar duplicata, então
  consumidores devem deduplicar por `eventId`.
- **Referências fora de ordem:** operações sem referência ficam em
  `PENDING_REFERENCE` e são tentadas novamente com backoff. Após dez tentativas,
  são rejeitadas com `REFERENCE_NOT_FOUND`.
- **MikroORM e SQL:** MikroORM integra conexões e transações ao NestJS. SQL
  parametrizado deixa locks, `ON CONFLICT` e `SKIP LOCKED` explícitos, mas
  mantém parte do mapeamento e da persistência sob responsabilidade do serviço.

O publisher da outbox mantém uma transação do banco durante a chamada ao SQS.
Isso simplifica a disputa entre publishers, mas pode prolongar locks se a fila
estiver lenta. Uma estratégia futura de reserva com lease poderia reduzir esse
tempo, desde que também trate leases expirados e duplicatas.

## Autenticação

A autenticação foi deixada de fora conforme permitido pelo desafio.
`ProviderAuthGuard` é um ponto de extensão no-op e atualmente permite as
requisições sem validar a identidade do provedor. Antes de expor o serviço,
é necessário integrar um provedor OIDC/JWT e autorizar a identidade para o
`providerId` informado.

## Testes e limites conhecidos

Os testes de integração com PostgreSQL e LocalStack cobrem constraints,
entregas duplicadas, apostas concorrentes, carteiras distintas, redelivery SQS
e referência que chega depois. O teste de concorrência usa conexões ORM
separadas no mesmo processo; não comprova o comportamento de vários processos
do sistema operacional.

Ainda não há testes explícitos de crash/reinício entre commit e confirmação da
mensagem, encaminhamento real à DLQ, publishers independentes concorrendo pela
outbox ou várias instâncias em processos separados. Não apresentar esses
cenários como garantias já comprovadas.

Para executar e testar, consulte `README.md`. A configuração de infraestrutura
local e AWS está em `INFRAESTRUTURA.md`.
