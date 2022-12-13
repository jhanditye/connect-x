
## Table of contents

- [Overview](#overview)
  - [:duck: Intro](#intro)
  - [:seedling: Heuristic Agent](#heuristic-agent)
  - [:blossom: Simple DQN](#simple-dqn)
  - [:evergreen_tree: First Deep Learning Agent](#first-deep-learning-agent)
  - [Comparing my agents](#comparing-my-agents)
- [My process](#my-process)
  - [Built with](#built-with)
  - [What I learnt](#what-i-learnt)
  - [Continued development](#continued-development)


## Overview

### 🦆Intro

This project is inspired by the Kaggle Connect-X comptetition, which tasked competitors to create agents to play the classic Connect 4 game. 
If haven't played before, Connext 4 is two player game where players take turns to drop coloured discs into a vertical grid of seven columns. Each player uses has their own colour disc and the winner is the first player to make a line of four discs of their own colour. 
solution 

<p align="center">
  <img src="Connect_Four.gif" alt="A connect four game in action with colours yellow and red"  width="40%"/>
</p>

The comptetition is an attempt to teach deep reinforcement learning through a fun game. But before I consider a deep learning solution, I think it is worthwile to consider a manual bruteforce engineering solution. We can then later compare the agents we making to truly gauge the improvemnts that a deep learning solution could provide. 

### 🌱Heuristic Agent 

#### TLDR
- Make a heuristic function to score every possible board
- Look ahead N moves (maybe choose N small for fast computation) and pick the best move


My first solution is a rigid fixed engineeing solution. It relies on the idea that some positions of the board are clearly better than others, and if had some tangeable 'score' metric , we would want to take the moves that maximise our score and minimise the score of the opponent. For example, suppose the two discs are coloured red (:heart:) and yellow (:yellow_heart:). If you are the red player, one **heuristic** you might employ to every line of four discs could look like:

<p align="center">
  <img src="https://i.imgur.com/vzQa4ML.png" alt="A connect four game in action with colours yellow and red" width="70%"/>
</p>

A new board configuration could then be scored by the sum of all the patterns we see.

<p align="center">
  <img src="https://i.imgur.com/PtnLOHt.png" alt="A connect four game in action with colours yellow and red" width="80%"/>
</p>

Now notice that this allows us to look one step ahead. However, if you were a smart player, you would realise that this isn't necessarily the best thing to do. The best move right now might just allow the opponent to gain an optimal position later. Therefore, we need to find some way of looking forward many more steps. 

This is where the Minimax algorithm comes. For a concise visual explanation of the algorithm, we will assume that each player only has two possible move instead of seven. Again, we assume that we play as the red player. Suppose that after looking ahead three plays, the 'scores' for all posssible boards like this:

<p align="center">
  <img src="https://i.imgur.com/BrRe7Bu.png"  width="80%"/>
</p>

Now, even though there is the possibility of attaining a score of +40 for the agent, if we assume that the opponenet plays optimally, the opponent will try and ensure this possibility doesn't occur and we will make a move away from this path. From each of the four pairs of possibilities in the fourth level, our agent would pick the maximal score, so these values are passed onto the previous level of the tree. However, because the opponent wants us to lose, in the third level, the opoonent would want to pick the path that minimises our score. This information propagates up the tree to the root node, deciding the best path for the agent to take. 

<p align="center">
  <img src="https://i.imgur.com/bWezUC3.png"  width="80%"/>
</p>

You might ask be asking yourself "why we can't just do this for the game tree and pick the moves that gurantee a win?" The problem is that this is extremely computational expensive and only really works for small games like tic-tac-toe. Thus, we can only really look forward a few steps. 

### 🌼Simple DQN 
Coming soon! Expected date : 15/12/2022
### 🌲First Deep Learning Agent 
Coming soon!

### Comparing my agents

##  My Process

### Built with

- Python
- TensorFlow

### What I learnt

1. MiniMax algorithm, and its computational improvements such as alpha-beta pruning
2. Reinforcement learning Q-function types

### Continued development

1. Read Deepmind's paper on Atari games


Feel free to contact me if you'd like to work on this with me or just want to talk about reinforcement learning!


