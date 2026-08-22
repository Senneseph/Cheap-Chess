#!/usr/bin/env python3
"""Independent reference perft (pure Python, slow) for debugging Cheap Chess."""
import sys

EMPTY, P, N, B, R, Q, K = 0, 1, 2, 3, 4, 5, 6
WHITE, BLACK = 1, -1

def parse_fen(fen):
    parts = fen.split()
    board = [0]*64
    r = 7
    for row in parts[0].split('/'):
        f = 0
        for ch in row:
            if ch.isdigit():
                f += int(ch)
            else:
                pc = {'p':P,'n':N,'b':B,'r':R,'q':Q,'k':K}[ch.lower()]
                color = WHITE if ch.isupper() else BLACK
                board[r*8+f] = pc*color
                f += 1
        r -= 1
    turn = 1 if parts[1]=='w' else -1
    rights = 0
    for ch in parts[2]:
        rights |= {'K':1,'Q':2,'k':4,'q':8}.get(ch,0)
    ep = -1
    if parts[3] != '-':
        ep = (ord(parts[3][0])-97) + (int(parts[3][1])-1)*8
    return {'b':board,'turn':turn,'rights':rights,'ep':ep}

def is_attacked(board, sq, by):
    f = sq & 7
    if by == WHITE:
        if f>0 and sq>=9 and board[sq-9]==P: return True
        if f<7 and sq>=7 and board[sq-7]==P: return True
    else:
        if f<7 and sq<=54 and board[sq+9]==-P: return True
        if f>0 and sq<=56 and board[sq+7]==-P: return True
    for o in (17,15,10,6,-6,-10,-15,-17):
        t = sq+o
        if 0<=t<64 and abs((t&7)-f)<=2 and board[t]==by*N: return True
    for o in (1,7,8,9,-1,-7,-8,-9):
        t = sq+o
        if 0<=t<64 and -1<=(t&7)-f<=1 and board[t]==by*K: return True
    for d in (1,-1,8,-8):
        t = sq+d; steps=1
        while 0<=t<64 and ((d in (1,-1) and (t&7)==f+d*steps) or (d in (8,-8) and (t>>3)==(sq>>3)+(1 if d>0 else -1)*steps)):
            pc = board[t]
            if pc:
                if pc in (by*R, by*Q): return True
                break
            steps+=1; t = sq+d*steps
    for d in (7,-7,9,-9):
        df = -1 if d in (7,-9) else 1
        steps=0; t = sq+d
        while 0<=t<64 and (t&7)-f==df*(steps+1) and (t>>3)-(sq>>3)==(1 if d>0 else -1)*(steps+1):
            pc = board[t]
            if pc:
                if pc in (by*B, by*Q): return True
                break
            steps+=1; t = sq+d*(steps+1)
    return False

def king_sq(board, color):
    for i in range(64):
        if board[i]==color*K: return i
    return -1

def gen_moves(s):
    board, turn = s['b'], s['turn']
    moves = []
    for sq in range(64):
        pc = board[sq]
        if not pc or (pc>0)!= (turn==WHITE): continue
        piece = abs(pc); f = sq&7; r = sq>>3
        if piece == P:
            d = 8 if turn==WHITE else -8
            promo = r == (6 if turn==WHITE else 1)
            t = sq+d
            if 0<=t<64 and board[t]==0:
                if promo:
                    for p in (Q,R,B,N): moves.append((sq,t,p))
                else:
                    moves.append((sq,t,0))
                    start = 1 if turn==WHITE else 6
                    if r==start:
                        t2 = sq+2*d
                        if board[t2]==0: moves.append((sq,t2,0))
            for df in (-1,1):
                tf = f+df
                if not 0<=tf<8: continue
                t = sq+d+df
                if not 0<=t<64: continue
                victim = board[t]
                if victim and (victim>0)!=(turn==WHITE):
                    if promo:
                        for p in (Q,R,B,N): moves.append((sq,t,p))
                    else:
                        moves.append((sq,t,0))
                elif t==s['ep'] and board[t]==0:
                    moves.append((sq,t,0))
        elif piece == N:
            for o in (17,15,10,6,-6,-10,-15,-17):
                t = sq+o
                if 0<=t<64 and abs((t&7)-f)<=2:
                    victim = board[t]
                    if victim==0 or (victim>0)!=(turn==WHITE): moves.append((sq,t,0))
        elif piece == K:
            for o in (1,7,8,9,-1,-7,-8,-9):
                t = sq+o
                if 0<=t<64 and -1<=(t&7)-f<=1:
                    victim = board[t]
                    if victim==0 or (victim>0)!=(turn==WHITE): moves.append((sq,t,0))
            enemy = -turn
            if turn==WHITE and sq==4:
                if s['rights']&1 and board[5]==0 and board[6]==0 and board[7]==R and not is_attacked(board,4,enemy) and not is_attacked(board,5,enemy) and not is_attacked(board,6,enemy):
                    moves.append((4,6,0))
                if s['rights']&2 and board[3]==0 and board[2]==0 and board[1]==0 and board[0]==R and not is_attacked(board,4,enemy) and not is_attacked(board,3,enemy) and not is_attacked(board,2,enemy):
                    moves.append((4,2,0))
            elif turn==BLACK and sq==60:
                if s['rights']&4 and board[61]==0 and board[62]==0 and board[63]==-R and not is_attacked(board,60,enemy) and not is_attacked(board,61,enemy) and not is_attacked(board,62,enemy):
                    moves.append((60,62,0))
                if s['rights']&8 and board[59]==0 and board[58]==0 and board[57]==0 and board[56]==-R and not is_attacked(board,60,enemy) and not is_attacked(board,59,enemy) and not is_attacked(board,58,enemy):
                    moves.append((60,58,0))
        else:
            dirs = (1,-1,8,-8) if piece==R else (7,-7,9,-9) if piece==B else (1,-1,8,-8,7,-7,9,-9)
            for d in dirs:
                t = sq+d; steps=1
                while 0<=t<64:
                    ok = False
                    if d in (1,-1): ok = (t&7)==f+d*steps
                    elif d in (8,-8): ok = (t>>3)==r+(1 if d>0 else -1)*steps
                    else:
                        df = -1 if d in (7,-9) else 1
                        ok = (t&7)==f+df*steps and (t>>3)==r+(1 if d>0 else -1)*steps
                    if not ok: break
                    victim = board[t]
                    if victim==0:
                        moves.append((sq,t,0))
                    else:
                        if (victim>0)!=(turn==WHITE): moves.append((sq,t,0))
                        break
                    steps+=1; t = sq+d*steps
    return moves

def apply(s, mv):
    board = list(s['b']); turn = s['turn']
    f, t, promo = mv
    piece = abs(board[f])
    board[f] = 0
    captured = 0
    if t == s['ep'] and piece==P:
        victim = t - 8*turn
        captured = board[victim]; board[victim] = 0
    else:
        captured = board[t]; board[t] = 0
    board[t] = (promo if promo else piece)*turn
    rights = s['rights']
    if piece==K: rights &= ~(1 if turn==WHITE else 4 | 2 if turn==WHITE else 8)
    if piece==K and turn==WHITE: rights &= ~3
    if piece==K and turn==BLACK: rights &= ~12
    if piece==R:
        if f==0: rights &= ~2
        if f==7: rights &= ~1
        if f==56: rights &= ~8
        if f==63: rights &= ~4
    if captured:
        if t==0: rights &= ~2
        if t==7: rights &= ~1
        if t==56: rights &= ~8
        if t==63: rights &= ~4
    if piece==P and abs(t-f)==16:
        ep = (f+t)//2
    else:
        ep = -1
    return {'b':board,'turn':-turn,'rights':rights,'ep':ep}

def legal(s):
    out = []
    for mv in gen_moves(s):
        n = apply(s, mv)
        if not is_attacked(n['b'], king_sq(n['b'], s['turn']), -s['turn']):
            out.append(mv)
    return out

def perft(s, d):
    if d==0: return 1
    moves = legal(s)
    if d==1: return len(moves)
    return sum(perft(apply(s,m), d-1) for m in moves)

if __name__ == '__main__':
    fen = sys.argv[1]
    depth = int(sys.argv[2]) if len(sys.argv)>2 else 2
    s = parse_fen(fen)
    if len(sys.argv)>3 and sys.argv[3]=='divide':
        for mv in legal(s):
            print(mv, perft(apply(s,mv), depth-1))
    else:
        print(perft(s, depth))
