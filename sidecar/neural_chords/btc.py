"""
BTC, the bi-directional transformer chord recogniser of Park et al., ISMIR 2019,
reduced to inference (https://github.com/jayg996/BTC-ISMIR19, MIT; see LICENSE-BTC).

The module and parameter names are the original's so its pretrained weights load
strictly; training, attention maps and the CRF are left out. torch is imported
here and nowhere else in this package, so the rest can be used and tested without it.
"""

import math

import numpy as np
import torch
import torch.nn as nn

FEATURE_BINS = 144
TIMESTEP = 108
HIDDEN = 128
LAYERS = 8
HEADS = 4
CLASSES = 170


def _bias_mask(length: int) -> torch.Tensor:
    """-inf above the diagonal: a position may not attend to the future."""
    mask = torch.from_numpy(np.triu(np.full([length, length], -np.inf), 1)).type(torch.FloatTensor)
    return mask.unsqueeze(0).unsqueeze(1)


def _timing_signal(length: int, channels: int) -> torch.Tensor:
    position = np.arange(length)
    num_timescales = channels // 2
    increment = math.log(1.0e4) / (float(num_timescales) - 1)
    inverse = np.exp(np.arange(num_timescales).astype(np.float64) * -increment)
    scaled = np.expand_dims(position, 1) * np.expand_dims(inverse, 0)
    signal = np.concatenate([np.sin(scaled), np.cos(scaled)], axis=1)
    signal = np.pad(signal, [[0, 0], [0, channels % 2]], "constant", constant_values=[0.0, 0.0])
    return torch.from_numpy(signal.reshape([1, length, channels])).type(torch.FloatTensor)


class LayerNorm(nn.Module):
    def __init__(self, features: int, eps: float = 1e-6):
        super().__init__()
        self.gamma = nn.Parameter(torch.ones(features))
        self.beta = nn.Parameter(torch.zeros(features))
        self.eps = eps

    def forward(self, x):
        mean = x.mean(-1, keepdim=True)
        std = x.std(-1, keepdim=True)
        return self.gamma * (x - mean) / (std + self.eps) + self.beta


class MultiHeadAttention(nn.Module):
    def __init__(self, depth: int, heads: int, bias_mask: torch.Tensor):
        super().__init__()
        self.num_heads = heads
        self.query_scale = (depth // heads) ** -0.5
        self.bias_mask = bias_mask
        self.query_linear = nn.Linear(depth, depth, bias=False)
        self.key_linear = nn.Linear(depth, depth, bias=False)
        self.value_linear = nn.Linear(depth, depth, bias=False)
        self.output_linear = nn.Linear(depth, depth, bias=False)

    def _split(self, x):
        b, t, d = x.shape
        return x.view(b, t, self.num_heads, d // self.num_heads).permute(0, 2, 1, 3)

    def forward(self, x):
        q, k, v = (self._split(f(x)) for f in (self.query_linear, self.key_linear, self.value_linear))
        q = q * self.query_scale
        logits = torch.matmul(q, k.permute(0, 1, 3, 2))
        logits = logits + self.bias_mask[:, :, : logits.shape[-2], : logits.shape[-1]].type_as(logits)
        context = torch.matmul(torch.softmax(logits, dim=-1), v)
        b, h, t, d = context.shape
        return self.output_linear(context.permute(0, 2, 1, 3).contiguous().view(b, t, d * h))


class Conv(nn.Module):
    """Pads both sides, then a width-3 convolution, on [batch, time, channels]."""

    def __init__(self, size_in: int, size_out: int):
        super().__init__()
        self.pad = nn.ConstantPad1d((1, 1), 0)
        self.conv = nn.Conv1d(size_in, size_out, kernel_size=3, padding=0)

    def forward(self, x):
        return self.conv(self.pad(x.permute(0, 2, 1))).permute(0, 2, 1)


class PositionwiseFeedForward(nn.Module):
    def __init__(self, depth: int):
        super().__init__()
        self.layers = nn.ModuleList([Conv(depth, depth), Conv(depth, depth)])
        self.relu = nn.ReLU()

    def forward(self, x):
        for layer in self.layers:
            x = self.relu(layer(x))
        return x


class SelfAttentionBlock(nn.Module):
    def __init__(self, depth: int, heads: int, bias_mask: torch.Tensor):
        super().__init__()
        self.multi_head_attention = MultiHeadAttention(depth, heads, bias_mask)
        self.positionwise_convolution = PositionwiseFeedForward(depth)
        self.layer_norm_mha = LayerNorm(depth)
        self.layer_norm_ffn = LayerNorm(depth)

    def forward(self, x):
        x = x + self.multi_head_attention(self.layer_norm_mha(x))
        return x + self.positionwise_convolution(self.layer_norm_ffn(x))


class BiDirectionalSelfAttention(nn.Module):
    """One layer: a forward-masked and a backward-masked block, joined by a linear map."""

    def __init__(self, depth: int, heads: int, length: int):
        super().__init__()
        mask = _bias_mask(length)
        self.attn_block = SelfAttentionBlock(depth, heads, mask)
        self.backward_attn_block = SelfAttentionBlock(depth, heads, torch.transpose(mask, dim0=2, dim1=3))
        self.linear = nn.Linear(depth * 2, depth)

    def forward(self, x):
        return self.linear(torch.cat((self.attn_block(x), self.backward_attn_block(x)), dim=2))


class BiDirectionalSelfAttentionLayers(nn.Module):
    def __init__(self, features: int, depth: int, layers: int, heads: int, length: int):
        super().__init__()
        self.timing_signal = _timing_signal(length, depth)
        self.embedding_proj = nn.Linear(features, depth, bias=False)
        self.self_attn_layers = nn.Sequential(*[BiDirectionalSelfAttention(depth, heads, length) for _ in range(layers)])
        self.layer_norm = LayerNorm(depth)

    def forward(self, x):
        x = self.embedding_proj(x)
        x = x + self.timing_signal[:, : x.shape[1], :].type_as(x)
        return self.layer_norm(self.self_attn_layers(x))


class OutputLayer(nn.Module):
    def __init__(self, depth: int, classes: int):
        super().__init__()
        self.output_projection = nn.Linear(depth, classes)
        # Unused at inference; present because the pretrained weights contain it.
        self.lstm = nn.LSTM(input_size=depth, hidden_size=depth // 2, batch_first=True, bidirectional=True)


class BTC(nn.Module):
    """Features [batch, 108, 144] (log CQT, normalised) -> logits [batch, 108, 170]."""

    def __init__(self, features: int = FEATURE_BINS, depth: int = HIDDEN, layers: int = LAYERS,
                 heads: int = HEADS, length: int = TIMESTEP, classes: int = CLASSES):
        super().__init__()
        self.self_attn_layers = BiDirectionalSelfAttentionLayers(features, depth, layers, heads, length)
        self.output_layer = OutputLayer(depth, classes)

    def forward(self, x):
        return self.output_layer.output_projection(self.self_attn_layers(x))
