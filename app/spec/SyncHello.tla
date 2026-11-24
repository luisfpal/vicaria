---------------------------- MODULE SyncHello ----------------------------
(* The hello and ops exchange of src/sync/protocol.ts (Session), abstracted:
   devices hold sets of op ids; a hello carries the sender's set (its summary); the receiver answers with the ops the
   sender lacks; new and newly merged ops go to every peer whose hello this side holds; ops from a peer whose hello this
   side lacks are dropped.  A connection can drop on one side only (a page reload or a lost data channel): that side
   forgets the peer, loses what was in flight to it, and joins again.  Channels are FIFO per direction (WebRTC data
   channels and the relay both are).
   Nonces = TRUE models the fix: each join picks a fresh nonce; a hello carries the sender's nonce and the last nonce
   it got from the receiver; a hello whose ack is not the receiver's current nonce is answered; the missing ops are
   sent once per peer nonce.  Nonces = FALSE is the earlier rule: answer only if this side has not sent a hello. *)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Dev, Writers, Writes, Resets, Nonces, MaxNonce  \* Writers: the devices that write (a subset keeps 3-device runs small)

VARIABLES store, chan, heard, said, mine, theirs, sentFor, writes, resets

vars == <<store, chan, heard, said, mine, theirs, sentFor, writes, resets>>
Op == Dev \X (1..Writes)
None == 0
Peers(d) == Dev \ {d}

Send(c, from, to, m) == [c EXCEPT ![from][to] = Append(@, m)]

Init ==
  /\ store = [d \in Dev |-> {}]
  /\ chan = [a \in Dev |-> [b \in Dev |-> <<>>]]
  /\ heard = [a \in Dev |-> [b \in Dev |-> FALSE]]
  /\ said = [a \in Dev |-> [b \in Dev |-> FALSE]]
  /\ mine = [a \in Dev |-> [b \in Dev |-> None]]      \* my nonce for this connection
  /\ theirs = [a \in Dev |-> [b \in Dev |-> None]]    \* last nonce I got from the peer
  /\ sentFor = [a \in Dev |-> [b \in Dev |-> None]]   \* peer nonce I sent the missing ops for
  /\ writes = [d \in Dev |-> 0]
  /\ resets = 0

Hello(d, p, n) == [t |-> "hello", sum |-> store[d], n |-> n, ack |-> theirs[d][p]]

\* d starts (or restarts) its side of the connection to p
Join(d, p) ==
  /\ ~said[d][p]
  /\ \E n \in 1..MaxNonce :
       /\ n # mine[d][p]
       /\ said' = [said EXCEPT ![d][p] = TRUE]
       /\ mine' = [mine EXCEPT ![d][p] = n]
       /\ chan' = Send(chan, d, p, Hello(d, p, n))
  /\ UNCHANGED <<store, heard, theirs, sentFor, writes, resets>>

\* d's side of the connection drops and comes back: it forgets p and loses what was in flight to it
Reset(d, p) ==
  /\ resets < Resets /\ said[d][p]
  /\ resets' = resets + 1
  /\ heard' = [heard EXCEPT ![d][p] = FALSE]
  /\ said' = [said EXCEPT ![d][p] = FALSE]
  /\ theirs' = [theirs EXCEPT ![d][p] = None]
  /\ sentFor' = [sentFor EXCEPT ![d][p] = None]
  /\ chan' = [chan EXCEPT ![p][d] = <<>>]
  /\ UNCHANGED <<store, mine, writes>>

Write(d) ==
  /\ d \in Writers /\ writes[d] < Writes
  /\ LET o == <<d, writes[d] + 1>> IN
     /\ writes' = [writes EXCEPT ![d] = @ + 1]
     /\ store' = [store EXCEPT ![d] = @ \cup {o}]
     /\ chan' = [a \in Dev |-> [b \in Dev |->
                  IF a = d /\ heard[d][b] THEN Append(chan[a][b], [t |-> "ops", ops |-> {o}]) ELSE chan[a][b]]]
  /\ UNCHANGED <<heard, said, mine, theirs, sentFor, resets>>

\* the handlers get the channels with the message already taken off (c)
RecvHello(d, p, m, c) ==
  LET answer == IF Nonces THEN m.ack # mine[d][p] \/ ~said[d][p] ELSE ~said[d][p]
      n == IF said[d][p] THEN mine[d][p] ELSE (mine[d][p] % MaxNonce) + 1
      give == IF Nonces /\ sentFor[d][p] = m.n THEN {} ELSE store[d] \ m.sum
      c1 == IF answer THEN Send(c, d, p, [t |-> "hello", sum |-> store[d], n |-> n, ack |-> m.n]) ELSE c
  IN /\ heard' = [heard EXCEPT ![d][p] = TRUE]
     /\ said' = [said EXCEPT ![d][p] = TRUE]
     /\ mine' = [mine EXCEPT ![d][p] = n]
     /\ theirs' = [theirs EXCEPT ![d][p] = m.n]
     /\ sentFor' = [sentFor EXCEPT ![d][p] = m.n]
     /\ chan' = IF give = {} THEN c1 ELSE [c1 EXCEPT ![d][p] = Append(@, [t |-> "ops", ops |-> give])]
     /\ UNCHANGED store

RecvOps(d, p, m, c) ==
  IF ~heard[d][p] THEN /\ chan' = c /\ UNCHANGED <<store, heard, said, mine, theirs, sentFor>>
  ELSE LET fresh == m.ops \ store[d] IN
       /\ store' = [store EXCEPT ![d] = @ \cup m.ops]
       /\ chan' = [a \in Dev |-> [b \in Dev |->
                    IF a = d /\ b # p /\ heard[d][b] /\ fresh # {} THEN Append(c[a][b], [t |-> "ops", ops |-> fresh]) ELSE c[a][b]]]
       /\ UNCHANGED <<heard, said, mine, theirs, sentFor>>

Recv(d, p) ==
  /\ chan[p][d] # <<>>
  /\ LET m == Head(chan[p][d])
         c == [chan EXCEPT ![p][d] = Tail(@)]
     IN IF m.t = "hello" THEN RecvHello(d, p, m, c) ELSE RecvOps(d, p, m, c)
  /\ UNCHANGED <<writes, resets>>

Next ==
  \E d \in Dev : \/ Write(d)
                 \/ \E p \in Peers(d) : Join(d, p) \/ Reset(d, p) \/ Recv(d, p)

Spec == Init /\ [][Next]_vars

\* Quiet: no writes or drops left, both sides joined, nothing in flight.  Then every device holds every op.
Quiet == /\ \A d \in Writers : writes[d] = Writes
         /\ resets = Resets
         /\ \A a, b \in Dev : chan[a][b] = <<>>
         /\ \A a \in Dev : \A b \in Peers(a) : said[a][b]
Converged == Quiet => \A a, b \in Dev : store[a] = store[b]
\* nothing is stuck: when it is quiet, every side has heard every other
NotQuiet == ~Quiet  \* Vacuity.cfg: TLC must find this violated (quiet states exist)
Connected == Quiet => \A a \in Dev : \A b \in Peers(a) : heard[a][b]
=============================================================================
